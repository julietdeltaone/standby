/**
 * Standby — backend (Google Apps Script, V8)
 * Trip-sharing for friends in the North Country.
 *
 * SIMPLIFIED MODEL (v3, Nov 25, 2026):
 *   Standby is a read-only trip board. Someone posts a trip; viewers see
 *   who is going where and when, and contact the driver outside the app.
 *   The ONLY interaction is an "Interested" toggle: one per signed-in user
 *   per trip, on/off. Interested marks are what fill seats:
 *   seats left = seats total minus interested count. There is no request,
 *   approval, or contact-exchange system.
 *
 * Data lives in the "Standby Data" Google Sheet with tabs:
 *   Trips, Users, Usage, Interested (Requests is legacy, unused by v3)
 * The spreadsheet ID and the admin password live in Script Properties
 * (SPREADSHEET_ID, ADMIN_PASSWORD). They are never in this file.
 *
 * Identity model (prototype): a user picks a display name + PIN. The
 * server stores the readable PIN for administrator management and returns a random
 * session token. Only the token's hash is stored. Every mutating call
 * resolves the user FROM THE TOKEN on the server; a submitted name or
 * user id is never trusted. Ownership = the user_id stored on the trip
 * row must equal the token's user_id. Identity type for stats:
 * "self-entered" (name+PIN). Visitors who never register are
 * "anonymous". There is no verified identity (the web app is open to
 * anyone with the link).
 *
 * All api* functions return { ok: true, data: ... } or
 * { ok: false, code: 'SOME_CODE', error: 'human message' }.
 * They never throw across google.script.run.
 */

var TZ = 'America/New_York';
var TABS = { trips: 'Trips', users: 'Users', usage: 'Usage', interested: 'Interested' };

/* ---------------- plumbing ---------------- */

function ss_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID script property is not set');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

/** Read a whole tab into objects: { _row: 2, colName: value, ... } */
function rows_(tabName) {
  var sh = sheet_(tabName);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var o = { _row: r + 1 };
    for (var c = 0; c < head.length; c++) o[head[c]] = values[r][c];
    out.push(o);
  }
  return out;
}

function append_(tabName, obj) {
  var sh = sheet_(tabName);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var row = head.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sh.appendRow(row);
  return sh.getLastRow();
}

function setCells_(tabName, rowNum, updates) {
  var sh = sheet_(tabName);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var range = sh.getRange(rowNum, 1, 1, head.length);
  var row = range.getValues()[0];
  Object.keys(updates).forEach(function(k) { var idx = head.indexOf(k); if(idx >= 0) row[idx] = updates[k]; });
  range.setValues([row]);
}

function hash_(s) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function newId_(prefix) { return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
function newToken_() { return Utilities.getUuid() + Utilities.getUuid(); }
function nowIso_() { return new Date(); }

function fmtDisplay_(d) {
  return Utilities.formatDate(d, TZ, "EEE, MMM d, yyyy 'at' h:mm a 'ET'");
}

function logUsage_(actor, identityType, action, detail) {
  try {
    append_(TABS.usage, {
      event_id: newId_('ev'), ts: nowIso_(), actor: actor || '',
      identity_type: identityType, action: action, detail: detail || ''
    });
  } catch (e) { /* logging must never break the app */ }
}

function ok_(data) { return { ok: true, data: JSON.parse(JSON.stringify(data)) }; }
function err_(code, message) { return { ok: false, code: code, error: message }; }
function wrap_(fn) { try { return fn(); } catch (e) { return err_('SERVER', String(e && e.message || e)); } }

/* ---------------- schema (self-healing) ---------------- */

var _ensured = false;
/**
 * v3 added two Trips columns (trip_type, approx) and an Interested tab.
 * Older sheets do not have them, so the first call in each execution
 * creates whatever is missing. Idempotent and cheap after the first run.
 */
function ensureSchema_() {
  if (_ensured) return;
  var ss = ss_();
  var trips = sheet_(TABS.trips);
  var head = trips.getRange(1, 1, 1, Math.max(trips.getLastColumn(), 1)).getValues()[0];
  ['trip_type', 'approx'].forEach(function (col) {
    if (head.indexOf(col) < 0) {
      trips.getRange(1, trips.getLastColumn() + 1).setValue(col);
      head.push(col);
    }
  });
  if (!ss.getSheetByName(TABS.interested)) {
    var sh = ss.insertSheet(TABS.interested);
    sh.getRange(1, 1, 1, 5).setValues([['interest_id', 'trip_id', 'user_id', 'user_name', 'created_at']]);
  }
  var users = sheet_(TABS.users);
  var uh = users.getRange(1, 1, 1, users.getLastColumn()).getValues()[0];
  if (uh.indexOf('pin') < 0) users.getRange(1, users.getLastColumn() + 1).setValue('pin');
  uh = users.getRange(1, 1, 1, users.getLastColumn()).getValues()[0];
  users.getRange(2, uh.indexOf('pin') + 1, users.getMaxRows() - 1, 1).setNumberFormat('@');
  _ensured = true;

}

/* ---------------- identity ---------------- */

/** Resolve the caller from a session token. Returns the user row object or null. */
function authUser_(token) {
  ensureSchema_();
  if (!token) return null;
  var th = hash_(token);
  var users = rows_(TABS.users);
  for (var i = 0; i < users.length; i++) {
    if (users[i].token_hash === th) {
      if (Date.now() - new Date(users[i].last_seen_at).getTime() > 300000) setCells_(TABS.users, users[i]._row, { last_seen_at: nowIso_() });
      return users[i];
    }
  }
  return null;
}

/* ---------------- trips ---------------- */

/** Map trip_id -> { count, names: [...], mine: bool } from the Interested tab. */
function interestMap_(myUserId) {
  var map = {};
  rows_(TABS.interested).forEach(function (r) {
    var m = map[r.trip_id] || (map[r.trip_id] = { count: 0, names: [], mine: false });
    m.count++;
    m.names.push(String(r.user_name || ''));
    if (myUserId && r.user_id === myUserId) m.mine = true;
  });
  return map;
}

function publicTrip_(t, myUserId, imap) {
  var depart = new Date(t.depart_at);
  var im = imap && imap[t.trip_id] ? imap[t.trip_id] : { count: 0, names: [], mine: false };
  var approx = t.approx === true || String(t.approx).toLowerCase() === 'true' || String(t.approx).toLowerCase() === 'yes';
  return {
    tripId: t.trip_id,
    driverName: t.driver_name,
    mine: myUserId ? t.driver_user_id === myUserId : false,
    origin: t.origin,
    destination: t.destination,
    tripType: t.trip_type === 'roundtrip' ? 'roundtrip' : 'oneway',
    approx: approx,
    departAt: depart.toISOString(),
    departLocal: Utilities.formatDate(depart, TZ, "yyyy-MM-dd'T'HH:mm"),
    departDisplay: fmtDisplay_(depart),
    pickup: t.pickup,
    seatsTotal: Number(t.seats_total),
    interestedCount: im.count,
    seatsLeft: Number(t.seats_total) - im.count,
    interestedNames: im.names,
    myInterested: im.mine,
    note: t.note,
    status: t.status
  };
}

function findTrip_(tripId) {
  var found = null;
  rows_(TABS.trips).forEach(function (x) { if (x.trip_id === tripId) found = x; });
  return found;
}

function parseTripInput_(trip, existingInterested) {
  trip = trip || {};
  var origin = String(trip.origin || '').trim();
  var destination = String(trip.destination || '').trim();
  if (!origin || !destination || origin.length > 120 || destination.length > 120) {
    return { error: err_('BAD_TRIP', 'Enter an origin and destination (up to 120 characters).') };
  }
  var depart;
  if (trip.departLocal) {
    // "yyyy-MM-ddTHH:mm" wall time, always interpreted in America/New_York.
    depart = Utilities.parseDate(String(trip.departLocal), TZ, "yyyy-MM-dd'T'HH:mm");
  } else {
    depart = new Date(Number(trip.departEpochMs));
  }
  if (isNaN(depart.getTime())) return { error: err_('BAD_TRIP', 'Departure time is missing or invalid.') };
  if (depart <= new Date()) return { error: err_('PAST_DEPARTURE', 'Departure must be in the future.') };
  var seats = Number(trip.seatsTotal);
  if (!(Number.isInteger(seats) && seats >= 1 && seats <= 8)) {
    return { error: err_('BAD_TRIP', 'Seats must be between 1 and 8.') };
  }
  if (existingInterested != null && seats < existingInterested) {
    return { error: err_('BAD_TRIP', 'Seats cannot be fewer than the ' + existingInterested + ' people already interested.') };
  }
  return {
    values: {
      origin: origin,
      destination: destination,
      depart_at: depart,
      pickup: String(trip.pickup || '').trim().slice(0, 300),
      note: String(trip.note || '').trim().slice(0, 600),
      seats_total: seats,
      trip_type: trip.tripType === 'roundtrip' ? 'roundtrip' : 'oneway',
      approx: trip.approx ? 'TRUE' : 'FALSE'
    }
  };
}

/* ---------------- entry point ---------------- */

function doGet() {
  logUsage_('', 'anonymous', 'visit', 'web app opened');
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Standby')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------------- users ---------------- */

function register_(name, pin) {
  return wrap_(function () {
    ensureSchema_();
    name = String(name || '').trim();
    pin = String(pin || '');
    if (name.length < 2 || name.length > 40) return err_('BAD_NAME', 'Display name must be 2 to 40 characters.');
    if (pin.length < 4 || pin.length > 32) return err_('BAD_PIN', 'PIN must be at least 4 characters.');
    var users = rows_(TABS.users);
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].display_name).toLowerCase() === name.toLowerCase()) {
        return err_('NAME_TAKEN', 'That display name is taken. If it is yours, log in with your PIN.');
      }
    }
    var token = newToken_();
    var userId = nextUserId_();
    append_(TABS.users, {
      user_id: userId, display_name: name, pin: pin,
      token_hash: hash_(token), created_at: nowIso_(), last_seen_at: nowIso_()
    });
    logUsage_(name, 'self-entered', 'register', '');
    return ok_({ user: { id: userId, name: name }, token: token });
  });
}

function apiRegister(name, pin) {
  return wrap_(function() {
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try { return register_(name, pin); } finally { lock.releaseLock(); }
  });
}

function apiLogin(name, pin) {
  return wrap_(function () {
    ensureSchema_();
    name = String(name || '').trim();
    pin = String(pin || '');
    var users = rows_(TABS.users);
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].display_name).toLowerCase() === name.toLowerCase()) {
        if (!pinMatches_(users[i], pin)) return err_('BAD_PIN', 'Wrong PIN for that name.');
        var token = newToken_();
        setCells_(TABS.users, users[i]._row, { pin: pin, pin_hash: '', salt: '', token_hash: hash_(token), last_seen_at: nowIso_() });
        logUsage_(users[i].display_name, 'self-entered', 'login', '');
        return ok_({ user: { id: users[i].user_id, name: users[i].display_name }, token: token });
      }
    }
    return err_('NO_SUCH_USER', 'No user with that display name. Register first.');
  });
}

function apiChangePin(token, currentPin, newPin) {
  return wrap_(function () {
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      var me = authUser_(token);
      if (!me) return err_('AUTH', 'Log in first.');
      if (!pinMatches_(me, String(currentPin || ''))) return err_('BAD_PIN', 'Current PIN is incorrect.');
      newPin = String(newPin || '');
      if (newPin.length < 4 || newPin.length > 32) return err_('BAD_PIN', 'Use 4 to 32 characters.');
      var next = newToken_();
      setCells_(TABS.users, me._row, { pin: newPin, salt: '', pin_hash: '', token_hash: hash_(next) });
      return ok_({ token: next });
    } finally { lock.releaseLock(); }
  });
}

/* ---------------- board ---------------- */

function apiListTrips(token) {
  return wrap_(function () {
    ensureSchema_();
    var me = token ? authUser_(token) : null;
    var imap = interestMap_(me ? me.user_id : null);
    var now = new Date();
    var trips = rows_(TABS.trips)
      .filter(function (t) { return t.status === 'open' && new Date(t.depart_at) > now; })
      .sort(function (a, b) { return new Date(a.depart_at) - new Date(b.depart_at); })
      .map(function (t) { return publicTrip_(t, me ? me.user_id : null, imap); });
    logUsage_(me ? me.display_name : '', me ? 'self-entered' : 'anonymous', 'list_trips', trips.length + ' upcoming');
    return ok_({ trips: trips, me: me ? { id: me.user_id, name: me.display_name } : null });
  });
}

function apiCreateTrip(token, trip) {
  return wrap_(function () {
    ensureSchema_();
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var parsed = parseTripInput_(trip, null);
    if (parsed.error) return parsed.error;
    var tripId = newId_('trp');
    var v = parsed.values;
    append_(TABS.trips, {
      trip_id: tripId, driver_user_id: me.user_id, driver_name: me.display_name,
      origin: v.origin, destination: v.destination, depart_at: v.depart_at,
      pickup: v.pickup, seats_total: v.seats_total, seats_taken: 0, note: v.note,
      status: 'open', created_at: nowIso_(), updated_at: nowIso_(),
      trip_type: v.trip_type, approx: v.approx
    });
    logUsage_(me.display_name, 'self-entered', 'create_trip', v.origin + ' to ' + v.destination);
    return ok_({ tripId: tripId });
  });
}

function apiEditTrip(token, tripId, trip) {
  return wrap_(function () {
    ensureSchema_();
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      var t = findTrip_(tripId);
      if (!t) return err_('NOT_FOUND', 'Trip not found.');
      if (t.driver_user_id !== me.user_id) return err_('NOT_OWNER', 'Only the driver can edit this trip.');
      if (t.status !== 'open' || new Date(t.depart_at) <= new Date()) return err_('NOT_OPEN', 'Only upcoming open trips can be edited.');
      var im = interestMap_(null)[tripId];
      var parsed = parseTripInput_(trip, im ? im.count : 0);
      if (parsed.error) return parsed.error;
      var v = parsed.values;
      setCells_(TABS.trips, t._row, {
        origin: v.origin, destination: v.destination, depart_at: v.depart_at,
        pickup: v.pickup, note: v.note, seats_total: v.seats_total,
        trip_type: v.trip_type, approx: v.approx, updated_at: nowIso_()
      });
      logUsage_(me.display_name, 'self-entered', 'edit_trip', tripId);
      return ok_({ tripId: tripId });
    } finally { lock.releaseLock(); }
  });
}

/* Deletion is a status flip; the row stays recoverable in the private Sheet. */
function apiDeleteTrip(token, tripId) {
  return wrap_(function () {
    ensureSchema_();
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      var t = findTrip_(tripId);
      if (!t) return err_('NOT_FOUND', 'Trip not found.');
      if (t.driver_user_id !== me.user_id) return err_('NOT_OWNER', 'Only the driver can delete this trip.');
      setCells_(TABS.trips, t._row, { status: 'deleted', seats_taken: 0, updated_at: nowIso_() });
      clearInterests_(tripId);
      logUsage_(me.display_name, 'self-entered', 'delete_trip', tripId);
      return ok_({ tripId: tripId });
    } finally { lock.releaseLock(); }
  });
}

function apiCancelTrip(token, tripId) {
  return wrap_(function () {
    ensureSchema_();
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      var t = findTrip_(tripId);
      if (!t) return err_('NOT_FOUND', 'Trip not found.');
      if (t.driver_user_id !== me.user_id) return err_('NOT_OWNER', 'Only the driver can cancel this trip.');
      if (t.status !== 'open') return err_('NOT_OPEN', 'Trip is not open.');
      setCells_(TABS.trips, t._row, { status: 'cancelled', updated_at: nowIso_() });
      clearInterests_(tripId);
      logUsage_(me.display_name, 'self-entered', 'cancel_trip', tripId);
      return ok_({ tripId: tripId });
    } finally { lock.releaseLock(); }
  });
}

/* ---------------- interested ---------------- */

function clearInterests_(tripId) {
  var sh = sheet_(TABS.interested);
  var mine = rows_(TABS.interested).filter(function (r) { return r.trip_id === tripId; });
  mine.sort(function (a, b) { return b._row - a._row; })
    .forEach(function (r) { sh.deleteRow(r._row); });
}

/** The one interaction on the board. On if absent, off if present. */
function apiToggleInterest(token, tripId) {
  return wrap_(function () {
    ensureSchema_();
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      var t = findTrip_(tripId);
      if (!t) return err_('NOT_FOUND', 'Trip not found.');
      if (t.status !== 'open') return err_('NOT_OPEN', 'Trip is not open.');
      if (new Date(t.depart_at) <= new Date()) return err_('PAST_DEPARTURE', 'This trip has already departed.');
      if (t.driver_user_id === me.user_id) return err_('OWN_TRIP', 'This is your own trip.');
      var existing = null;
      rows_(TABS.interested).forEach(function (r) {
        if (r.trip_id === tripId && r.user_id === me.user_id) existing = r;
      });
      var on;
      if (existing) {
        sheet_(TABS.interested).deleteRow(existing._row);
        on = false;
      } else {
        append_(TABS.interested, {
          interest_id: newId_('int'), trip_id: tripId, user_id: me.user_id,
          user_name: me.display_name, created_at: nowIso_()
        });
        on = true;
      }
      var im = interestMap_(me.user_id)[tripId] || { count: 0, names: [], mine: on };
      logUsage_(me.display_name, 'self-entered', on ? 'interest_on' : 'interest_off', tripId);
      return ok_({
        tripId: tripId, interested: on,
        interestedCount: im.count, seatsLeft: Number(t.seats_total) - im.count,
        interestedNames: im.names
      });
    } finally { lock.releaseLock(); }
  });
}

function apiMyStuff(token) {
  return wrap_(function () {
    ensureSchema_();
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var imap = interestMap_(me.user_id);
    var all = rows_(TABS.trips);
    var myTrips = all
      .filter(function (t) { return t.driver_user_id === me.user_id && t.status !== 'deleted'; })
      .sort(function (a, b) { return new Date(a.depart_at) - new Date(b.depart_at); })
      .map(function (t) { return publicTrip_(t, me.user_id, imap); });
    var now = new Date();
    var myInterested = all
      .filter(function (t) {
        return t.status === 'open' && new Date(t.depart_at) > now &&
          imap[t.trip_id] && imap[t.trip_id].mine && t.driver_user_id !== me.user_id;
      })
      .sort(function (a, b) { return new Date(a.depart_at) - new Date(b.depart_at); })
      .map(function (t) { return publicTrip_(t, me.user_id, imap); });
    return ok_({ myTrips: myTrips, myInterested: myInterested });
  });
}

/* ---------------- admin ---------------- */

function apiAdminLogin(password) {
  return wrap_(function () {
    var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
    if (!expected) return err_('NOT_CONFIGURED', 'Admin password is not set in Script Properties.');
    if (String(password || '') !== expected) return err_('BAD_PASSWORD', 'Wrong admin password.');
    var token = newToken_();
    CacheService.getScriptCache().put('admin:' + hash_(token), '1', 7200); // 2 hours
    logUsage_('admin', 'admin', 'admin_login', '');
    return ok_({ adminToken: token });
  });
}

function isAdmin_(adminToken) {
  if (!adminToken) return false;
  return CacheService.getScriptCache().get('admin:' + hash_(adminToken)) === '1';
}

function apiAdminStats(adminToken) {
  return wrap_(function () {
    ensureSchema_();
    if (!isAdmin_(adminToken)) return err_('AUTH', 'Admin login required.');
    var users = rows_(TABS.users);
    var trips = rows_(TABS.trips);
    var interests = rows_(TABS.interested);
    var usage = rows_(TABS.usage);
    function countBy(list, key) {
      var m = {};
      list.forEach(function (x) { var k = String(x[key] || ''); m[k] = (m[k] || 0) + 1; });
      return m;
    }
    var now = new Date();
    return ok_({
      usersTotal: users.length,
      users: users.map(function (u) {
        return { id: u.user_id, pin: String(u.pin == null ? '' : u.pin), name: u.display_name, identityType: 'self-entered', createdAt: u.created_at, lastSeenAt: u.last_seen_at };
      }),
      tripsTotal: trips.length,
      tripsByStatus: countBy(trips, 'status'),
      upcomingTrips: trips.filter(function (t) { return t.status === 'open' && new Date(t.depart_at) > now; }).length,
      interestsTotal: interests.length,
      usageByAction: countBy(usage, 'action'),
      usageByIdentity: countBy(usage, 'identity_type'),
      recentUsage: usage.slice(-20).reverse().map(function (e) {
        return { ts: e.ts, actor: e.actor, identityType: e.identity_type, action: e.action, detail: e.detail };
      })
    });
  });
}

/**
 * One-time setup helper. Run manually from the editor if the properties
 * were not set in Project Settings. Takes no arguments and reads nothing
 * secret from code: set the values in Project Settings > Script
 * Properties instead. This function only verifies configuration.
 */
function checkSetup() {
  var p = PropertiesService.getScriptProperties();
  Logger.log('SPREADSHEET_ID set: ' + !!p.getProperty('SPREADSHEET_ID'));
  Logger.log('ADMIN_PASSWORD set: ' + !!p.getProperty('ADMIN_PASSWORD'));
  Logger.log('Spreadsheet reachable: ' + ss_().getName());
}

/**
 * Fallback setup: creates the "Standby Data" spreadsheet (owned by this
 * script's account) with the tabs and header rows, and stores its ID
 * in the SPREADSHEET_ID script property. Run once from the editor only if
 * checkSetup shows the configured spreadsheet is not reachable.
 */
function setupSheet() {
  var ss = SpreadsheetApp.create('Standby Data');
  ss.setSpreadsheetTimeZone(TZ);
  var headers = {
    Trips: ['trip_id', 'driver_user_id', 'driver_name', 'origin', 'destination', 'depart_at', 'pickup', 'seats_total', 'seats_taken', 'note', 'status', 'created_at', 'updated_at', 'trip_type', 'approx'],
    Users: ['user_id', 'display_name', 'pin', 'token_hash', 'created_at', 'last_seen_at'],
    Usage: ['event_id', 'ts', 'actor', 'identity_type', 'action', 'detail'],
    Interested: ['interest_id', 'trip_id', 'user_id', 'user_name', 'created_at']
  };
  var first = ss.getSheets()[0];
  first.setName('Trips');
  Object.keys(headers).forEach(function (tab) {
    var sh = tab === 'Trips' ? first : (ss.getSheetByName(tab) || ss.insertSheet(tab));
    sh.getRange(1, 1, 1, headers[tab].length).setValues([headers[tab]]);
  });
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  Logger.log('Created spreadsheet: ' + ss.getUrl());
}


// Legacy hash verification is only a migration bridge. New PINs are plain text.
function pinMatches_(u, pin) {
  if (u.pin !== undefined && String(u.pin) !== '') return String(u.pin) === pin;
  return !!u.pin_hash && u.pin_hash === hash_(u.salt + ':' + pin);
}
function nextUserId_() {
  var max = 0;
  rows_(TABS.users).forEach(function(u) { var m = /^U(\d+)$/.exec(u.user_id); if (m) max = Math.max(max, Number(m[1])); });
  return 'U' + (max + 1);
}
function apiAdminSetPin(adminToken, userId, pin) {
  return wrap_(function() {
    if (!isAdmin_(adminToken)) return err_('AUTH', 'Admin login required.');
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try {
      ensureSchema_(); pin = String(pin == null ? '' : pin);
      if (pin.length < 4 || pin.length > 32) return err_('BAD_PIN', 'Use 4 to 32 characters.');
      var u = rows_(TABS.users).filter(function(u) { return u.user_id === userId; })[0];
      if (!u) return err_('NOT_FOUND', 'User not found.');
      setCells_(TABS.users, u._row, { pin: pin, pin_hash: '', salt: '', token_hash: '' });
      logUsage_('admin', 'admin', 'set_pin', userId);
      return ok_({ userId: userId });
    } finally { lock.releaseLock(); }
  });
}

/** Run once after deployment. Keeps ownership links and sessions intact. */
function migrateStandbyV4() {
  var lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    ensureSchema_(); var ss = ss_(); ss.setSpreadsheetTimeZone(TZ);
    var map = {}, users = rows_(TABS.users), next = 1;
    users.forEach(function(u) { var m = /^U(\d+)$/.exec(u.user_id); if(m) next = Math.max(next, Number(m[1]) + 1); });
    users.forEach(function(u) { if(u.user_id && !/^U\d+$/.test(u.user_id)) { map[u.user_id] = 'U' + next++; setCells_(TABS.users, u._row, {user_id: map[u.user_id]}); } });
    [['Trips','driver_user_id'],['Interested','user_id'],['Requests','rider_user_id']].forEach(function(pair) {
      if (!ss.getSheetByName(pair[0])) return;
      rows_(pair[0]).forEach(function(r) { if(map[r[pair[1]]]) { var update = {}; update[pair[1]] = map[r[pair[1]]]; setCells_(pair[0], r._row, update); } });
    });
    ss.getSheets().forEach(function(sh) {
      var h = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
      h.forEach(function(k,c) {
        if (!/(_at$|^ts$)/.test(k) || sh.getLastRow() < 2) return;
        var range = sh.getRange(2,c+1,sh.getLastRow()-1,1);
        range.setValues(range.getValues().map(function(v) { var d = v[0] ? new Date(v[0]) : null; return [d && !isNaN(d.getTime()) ? d : v[0]]; }));
        sh.getRange(2,c+1,sh.getMaxRows()-1,1).setNumberFormat('m/d/yyyy h:mm AM/PM');
      });
    });
    return {ok:true, migratedUsers:Object.keys(map).length};
  } finally { lock.releaseLock(); }
}

function apiAdminClearBoard(adminToken) {
  return wrap_(function() {
    if (!isAdmin_(adminToken)) return err_('AUTH', 'Admin login required.');
    var lock = LockService.getScriptLock(); lock.waitLock(15000);
    try { ensureSchema_(); rows_(TABS.trips).forEach(function(t) { if(t.status === 'open') setCells_(TABS.trips,t._row,{status:'deleted',updated_at:nowIso_()}); });
      var sh = sheet_(TABS.interested); if(sh.getLastRow()>1) sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).clearContent();
      return ok_({cleared:true});
    } finally { lock.releaseLock(); }
  });
}
