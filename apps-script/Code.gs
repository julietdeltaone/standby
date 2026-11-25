/**
 * Standby — backend (Google Apps Script, V8)
 * Trip-sharing for friends in the North Country.
 *
 * Data lives in the "Standby Data" Google Sheet with tabs:
 *   Trips, Requests, Users, Usage
 * The spreadsheet ID and the admin password live in Script Properties
 * (SPREADSHEET_ID, ADMIN_PASSWORD). They are never in this file.
 *
 * Identity model (v1 prototype):
 *   A user picks a display name + PIN. The server stores a salted SHA-256
 *   hash of the PIN and returns a random session token. Only the token's
 *   hash is stored. Every mutating call resolves the user FROM THE TOKEN
 *   on the server; a submitted name or user id is never trusted.
 *   Ownership = the user_id stored on the trip/request row must equal the
 *   token's user_id. Identity type for stats: "self-entered" (name+PIN).
 *   Visitors who never register are "anonymous". There is no verified
 *   identity in v1 (the web app is open to anyone with the link).
 *
 * All api* functions return { ok: true, data: ... } or
 * { ok: false, code: 'SOME_CODE', error: 'human message' }.
 * They never throw across google.script.run.
 */

var TZ = 'America/New_York';
var TABS = { trips: 'Trips', requests: 'Requests', users: 'Users', usage: 'Usage' };

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
  Object.keys(updates).forEach(function (k) {
    var idx = head.indexOf(k);
    if (idx >= 0) sh.getRange(rowNum, idx + 1).setValue(updates[k]);
  });
}

function hash_(s) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function newId_(prefix) { return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
function newToken_() { return Utilities.getUuid() + Utilities.getUuid(); }
function nowIso_() { return new Date().toISOString(); }

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

function ok_(data) { return { ok: true, data: data }; }
function err_(code, message) { return { ok: false, code: code, error: message }; }
function wrap_(fn) { try { return fn(); } catch (e) { return err_('SERVER', String(e && e.message || e)); } }

/** Resolve the caller from a session token. Returns the user row object or null. */
function authUser_(token) {
  if (!token) return null;
  var th = hash_(token);
  var users = rows_(TABS.users);
  for (var i = 0; i < users.length; i++) {
    if (users[i].token_hash === th) {
      setCells_(TABS.users, users[i]._row, { last_seen_at: nowIso_() });
      return users[i];
    }
  }
  return null;
}

function publicTrip_(t, myUserId, myReqByTrip) {
  var depart = new Date(t.depart_at);
  return {
    tripId: t.trip_id,
    driverName: t.driver_name,
    mine: myUserId ? t.driver_user_id === myUserId : false,
    origin: t.origin,
    destination: t.destination,
    departAt: t.depart_at,
    departDisplay: fmtDisplay_(depart),
    pickup: t.pickup,
    seatsTotal: Number(t.seats_total),
    seatsTaken: Number(t.seats_taken),
    seatsLeft: Number(t.seats_total) - Number(t.seats_taken),
    note: t.note,
    status: t.status,
    myRequest: myReqByTrip && myReqByTrip[t.trip_id] ? myReqByTrip[t.trip_id] : null
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

function apiRegister(name, pin) {
  return wrap_(function () {
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
    var salt = Utilities.getUuid();
    var token = newToken_();
    var userId = newId_('usr');
    append_(TABS.users, {
      user_id: userId, display_name: name, pin_hash: hash_(salt + ':' + pin),
      salt: salt, token_hash: hash_(token), created_at: nowIso_(), last_seen_at: nowIso_()
    });
    logUsage_(name, 'self-entered', 'register', '');
    return ok_({ user: { id: userId, name: name }, token: token });
  });
}

function apiLogin(name, pin) {
  return wrap_(function () {
    name = String(name || '').trim();
    pin = String(pin || '');
    var users = rows_(TABS.users);
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].display_name).toLowerCase() === name.toLowerCase()) {
        if (users[i].pin_hash !== hash_(users[i].salt + ':' + pin)) return err_('BAD_PIN', 'Wrong PIN for that name.');
        var token = newToken_();
        setCells_(TABS.users, users[i]._row, { token_hash: hash_(token), last_seen_at: nowIso_() });
        logUsage_(users[i].display_name, 'self-entered', 'login', '');
        return ok_({ user: { id: users[i].user_id, name: users[i].display_name }, token: token });
      }
    }
    return err_('NO_SUCH_USER', 'No user with that display name. Register first.');
  });
}

/* ---------------- trips ---------------- */

function apiListTrips(token) {
  return wrap_(function () {
    var me = token ? authUser_(token) : null;
    var myReq = {};
    if (me) {
      rows_(TABS.requests).forEach(function (r) {
        if (r.rider_user_id === me.user_id && (r.status === 'pending' || r.status === 'approved')) {
          myReq[r.trip_id] = { requestId: r.request_id, status: r.status };
        }
      });
    }
    var now = new Date();
    var trips = rows_(TABS.trips)
      .filter(function (t) { return t.status === 'open' && new Date(t.depart_at) > now; })
      .sort(function (a, b) { return new Date(a.depart_at) - new Date(b.depart_at); })
      .map(function (t) { return publicTrip_(t, me ? me.user_id : null, myReq); });
    logUsage_(me ? me.display_name : '', me ? 'self-entered' : 'anonymous', 'list_trips', trips.length + ' upcoming');
    return ok_({ trips: trips, me: me ? { id: me.user_id, name: me.display_name } : null });
  });
}

function apiCreateTrip(token, trip) {
  return wrap_(function () {
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    trip = trip || {};
    var origin = String(trip.origin || '').trim();
    var destination = String(trip.destination || '').trim();
    var pickup = String(trip.pickup || '').trim();
    var note = String(trip.note || '').trim();
    var seats = Number(trip.seatsTotal);
    var depart;
    if (trip.departLocal) {
      // "yyyy-MM-ddTHH:mm" wall time, always interpreted in America/New_York.
      depart = Utilities.parseDate(String(trip.departLocal), TZ, "yyyy-MM-dd'T'HH:mm");
    } else {
      depart = new Date(Number(trip.departEpochMs));
    }
    if (!origin || !destination) return err_('BAD_TRIP', 'Origin and destination are required.');
    if (isNaN(depart.getTime())) return err_('BAD_TRIP', 'Departure time is missing or invalid.');
    if (depart <= new Date()) return err_('PAST_DEPARTURE', 'Departure must be in the future.');
    if (!(seats >= 1 && seats <= 8)) return err_('BAD_TRIP', 'Seats must be between 1 and 8.');
    var tripId = newId_('trp');
    append_(TABS.trips, {
      trip_id: tripId, driver_user_id: me.user_id, driver_name: me.display_name,
      origin: origin, destination: destination, depart_at: depart.toISOString(),
      pickup: pickup, seats_total: seats, seats_taken: 0, note: note,
      status: 'open', created_at: nowIso_(), updated_at: nowIso_()
    });
    logUsage_(me.display_name, 'self-entered', 'create_trip', origin + ' to ' + destination);
    return ok_({ tripId: tripId });
  });
}

function apiCancelTrip(token, tripId) {
  return wrap_(function () {
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      var trips = rows_(TABS.trips);
      var t = null;
      trips.forEach(function (x) { if (x.trip_id === tripId) t = x; });
      if (!t) return err_('NOT_FOUND', 'Trip not found.');
      if (t.driver_user_id !== me.user_id) return err_('NOT_OWNER', 'Only the driver can cancel this trip.');
      if (t.status !== 'open') return err_('NOT_OPEN', 'Trip is not open.');
      setCells_(TABS.trips, t._row, { status: 'cancelled', updated_at: nowIso_() });
      rows_(TABS.requests).forEach(function (r) {
        if (r.trip_id === tripId && (r.status === 'pending' || r.status === 'approved')) {
          setCells_(TABS.requests, r._row, { status: 'cancelled', decided_at: nowIso_() });
        }
      });
      logUsage_(me.display_name, 'self-entered', 'cancel_trip', tripId);
      return ok_({ tripId: tripId });
    } finally { lock.releaseLock(); }
  });
}

/* ---------------- requests ---------------- */

function apiRequestSeat(token, tripId) {
  return wrap_(function () {
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      var t = null;
      rows_(TABS.trips).forEach(function (x) { if (x.trip_id === tripId) t = x; });
      if (!t) return err_('NOT_FOUND', 'Trip not found.');
      if (t.status !== 'open') return err_('NOT_OPEN', 'Trip is not open.');
      if (new Date(t.depart_at) <= new Date()) return err_('PAST_DEPARTURE', 'This trip has already departed.');
      if (t.driver_user_id === me.user_id) return err_('OWN_TRIP', 'You cannot request a seat on your own trip.');
      var dup = rows_(TABS.requests).some(function (r) {
        return r.trip_id === tripId && r.rider_user_id === me.user_id &&
          (r.status === 'pending' || r.status === 'approved');
      });
      if (dup) return err_('DUPLICATE', 'You already have an active request on this trip.');
      var requestId = newId_('req');
      append_(TABS.requests, {
        request_id: requestId, trip_id: tripId, rider_user_id: me.user_id,
        rider_name: me.display_name, status: 'pending', created_at: nowIso_(), decided_at: ''
      });
      logUsage_(me.display_name, 'self-entered', 'request_seat', tripId);
      return ok_({ requestId: requestId, status: 'pending' });
    } finally { lock.releaseLock(); }
  });
}

function apiCancelRequest(token, requestId) {
  return wrap_(function () {
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      var r = null;
      rows_(TABS.requests).forEach(function (x) { if (x.request_id === requestId) r = x; });
      if (!r) return err_('NOT_FOUND', 'Request not found.');
      if (r.rider_user_id !== me.user_id) return err_('NOT_OWNER', 'Only the rider can cancel this request.');
      if (r.status !== 'pending' && r.status !== 'approved') return err_('NOT_ACTIVE', 'Request is not active.');
      var wasApproved = r.status === 'approved';
      setCells_(TABS.requests, r._row, { status: 'cancelled', decided_at: nowIso_() });
      if (wasApproved) {
        var t = null;
        rows_(TABS.trips).forEach(function (x) { if (x.trip_id === r.trip_id) t = x; });
        if (t) setCells_(TABS.trips, t._row, { seats_taken: Math.max(0, Number(t.seats_taken) - 1), updated_at: nowIso_() });
      }
      logUsage_(me.display_name, 'self-entered', 'cancel_request', requestId);
      return ok_({ requestId: requestId });
    } finally { lock.releaseLock(); }
  });
}

function apiDecideRequest(token, requestId, decision) {
  return wrap_(function () {
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    if (decision !== 'approve' && decision !== 'decline') return err_('BAD_DECISION', 'Decision must be approve or decline.');
    var lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      var r = null;
      rows_(TABS.requests).forEach(function (x) { if (x.request_id === requestId) r = x; });
      if (!r) return err_('NOT_FOUND', 'Request not found.');
      var t = null;
      rows_(TABS.trips).forEach(function (x) { if (x.trip_id === r.trip_id) t = x; });
      if (!t) return err_('NOT_FOUND', 'Trip not found.');
      if (t.driver_user_id !== me.user_id) return err_('NOT_OWNER', 'Only the driver can decide on this request.');
      if (r.status !== 'pending') return err_('NOT_PENDING', 'Request is no longer pending.');
      if (decision === 'approve') {
        if (Number(t.seats_taken) >= Number(t.seats_total)) return err_('TRIP_FULL', 'No seats left on this trip.');
        setCells_(TABS.trips, t._row, { seats_taken: Number(t.seats_taken) + 1, updated_at: nowIso_() });
        setCells_(TABS.requests, r._row, { status: 'approved', decided_at: nowIso_() });
      } else {
        setCells_(TABS.requests, r._row, { status: 'declined', decided_at: nowIso_() });
      }
      logUsage_(me.display_name, 'self-entered', decision + '_request', requestId);
      return ok_({ requestId: requestId, status: decision === 'approve' ? 'approved' : 'declined' });
    } finally { lock.releaseLock(); }
  });
}

function apiMyStuff(token) {
  return wrap_(function () {
    var me = authUser_(token);
    if (!me) return err_('AUTH', 'Log in first.');
    var reqs = rows_(TABS.requests);
    var tripsById = {};
    rows_(TABS.trips).forEach(function (t) { tripsById[t.trip_id] = t; });
    var myTrips = rows_(TABS.trips)
      .filter(function (t) { return t.driver_user_id === me.user_id; })
      .sort(function (a, b) { return new Date(a.depart_at) - new Date(b.depart_at); })
      .map(function (t) {
        var p = publicTrip_(t, me.user_id, null);
        p.requests = reqs.filter(function (r) { return r.trip_id === t.trip_id; })
          .map(function (r) {
            return { requestId: r.request_id, riderName: r.rider_name, status: r.status, createdAt: r.created_at };
          });
        return p;
      });
    var myRequests = reqs
      .filter(function (r) { return r.rider_user_id === me.user_id; })
      .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })
      .map(function (r) {
        var t = tripsById[r.trip_id];
        return {
          requestId: r.request_id, status: r.status, createdAt: r.created_at,
          trip: t ? publicTrip_(t, me.user_id, null) : null
        };
      });
    return ok_({ myTrips: myTrips, myRequests: myRequests });
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
    if (!isAdmin_(adminToken)) return err_('AUTH', 'Admin login required.');
    var users = rows_(TABS.users);
    var trips = rows_(TABS.trips);
    var reqs = rows_(TABS.requests);
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
        return { name: u.display_name, identityType: 'self-entered', createdAt: u.created_at, lastSeenAt: u.last_seen_at };
      }),
      tripsTotal: trips.length,
      tripsByStatus: countBy(trips, 'status'),
      upcomingTrips: trips.filter(function (t) { return t.status === 'open' && new Date(t.depart_at) > now; }).length,
      requestsTotal: reqs.length,
      requestsByStatus: countBy(reqs, 'status'),
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
 * script's account) with the four tabs and header rows, and stores its ID
 * in the SPREADSHEET_ID script property. Run once from the editor only if
 * checkSetup shows the configured spreadsheet is not reachable.
 */
function setupSheet() {
  var ss = SpreadsheetApp.create('Standby Data');
  var headers = {
    Trips: ['trip_id', 'driver_user_id', 'driver_name', 'origin', 'destination', 'depart_at', 'pickup', 'seats_total', 'seats_taken', 'note', 'status', 'created_at', 'updated_at'],
    Requests: ['request_id', 'trip_id', 'rider_user_id', 'rider_name', 'status', 'created_at', 'decided_at'],
    Users: ['user_id', 'display_name', 'pin_hash', 'salt', 'token_hash', 'created_at', 'last_seen_at'],
    Usage: ['event_id', 'ts', 'actor', 'identity_type', 'action', 'detail']
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
