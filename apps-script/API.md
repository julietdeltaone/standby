# Standby backend API (Apps Script)

The web app serves `Index.html` from Apps Script HTML Service. The page calls
the functions below with `google.script.run`. There is no REST endpoint and
no cross-origin fetch; everything runs inside the Apps Script page.

Every function returns one of:

- `{ ok: true, data: { ... } }`
- `{ ok: false, code: "CODE", error: "Human-readable message" }`

Functions never throw across `google.script.run`; catch failures with
`withFailureHandler` only for transport-level errors.

## Model (v3, simplified Nov 25, 2026)

Standby is a read-only trip board. Drivers post trips; viewers see who is
going where and when, and contact the driver outside the app. The ONLY
interaction is an **Interested** toggle: one per signed-in user per trip,
on/off. Interested marks fill seats: seats left = seats total minus
interested count. There is no request, approval, or contact-exchange system.
The v1/v2 request functions (`apiRequestSeat`, `apiCancelRequest`,
`apiDecideRequest`) are removed; the `Requests` sheet tab is legacy and
unused by v3.

## Identity

- `apiRegister(name, pin)` → `{ user: { id, name }, token }`
  Errors: `BAD_NAME`, `BAD_PIN`, `NAME_TAKEN`.
- `apiLogin(name, pin)` → `{ user: { id, name }, token }` (rotates the token;
  the old token stops working). Errors: `NO_SUCH_USER`, `BAD_PIN`.
- `apiChangePin(token, currentPin, newPin)` → `{ token }` (new session token;
  the prior token is invalidated). Errors: `AUTH`, `BAD_PIN`.
- The client stores `token` (localStorage) and passes it as the first
  argument to every other call. The server resolves the user from the token
  hash. Display names and user ids sent by the client are never trusted.
- Identity types in usage stats: `anonymous` (no token), `self-entered`
  (name + PIN account), `admin`. There is no verified identity.

## Trips and interest

Trip object: `{ tripId, driverName, mine, origin, destination,
tripType: "oneway" | "roundtrip", approx (bool), departAt (ISO UTC),
departLocal ("yyyy-MM-ddTHH:mm", America/New_York), departDisplay,
pickup, seatsTotal, interestedCount, seatsLeft, interestedNames: [...],
myInterested (bool), note, status }`.

- `apiListTrips(tokenOrEmpty)` → `{ trips: [Trip], me: { id, name } | null }`.
  Only open trips departing in the future, sorted by departure.
- `apiCreateTrip(token, trip)` → `{ tripId }`.
  `trip`: `{ origin, destination, pickup, note, seatsTotal (1-8),
  departLocal: "yyyy-MM-ddTHH:mm", tripType, approx }`. `departLocal` is
  wall time in America/New_York (parsed server-side). (`departEpochMs` is
  also accepted.) Errors: `AUTH`, `BAD_TRIP`, `PAST_DEPARTURE`.
- `apiEditTrip(token, tripId, trip)` → `{ tripId }`. Owner only, upcoming
  open trips only. Seats cannot drop below the current interested count.
  Errors: `AUTH`, `NOT_FOUND`, `NOT_OWNER`, `NOT_OPEN`, `BAD_TRIP`,
  `PAST_DEPARTURE`.
- `apiDeleteTrip(token, tripId)` → `{ tripId }`. Owner only. Marks the trip
  `deleted` and clears its Interested marks; the row stays recoverable in
  the private Sheet. Errors: `AUTH`, `NOT_FOUND`, `NOT_OWNER`.
- `apiCancelTrip(token, tripId)` → `{ tripId }`. Owner only; marks the trip
  `cancelled` and clears its Interested marks.
  Errors: `AUTH`, `NOT_FOUND`, `NOT_OWNER`, `NOT_OPEN`.
- `apiToggleInterest(token, tripId)` → `{ tripId, interested,
  interestedCount, seatsLeft, interestedNames }`. On if absent, off if
  present. Runs under a script lock. Errors: `AUTH`, `NOT_FOUND`,
  `NOT_OPEN`, `PAST_DEPARTURE`, `OWN_TRIP`.
- `apiMyStuff(token)` → `{ myTrips: [Trip], myInterested: [Trip] }`.
  Error: `AUTH`.

## Admin

- `apiAdminLogin(password)` → `{ adminToken }` (valid 2 hours, kept in the
  script cache). The password itself lives only in Script Properties
  (`ADMIN_PASSWORD`); it is not in this repository or the client code.
  Errors: `NOT_CONFIGURED`, `BAD_PASSWORD`.
- `apiAdminStats(adminToken)` → `{ usersTotal, users: [{ id, pin, name,
  identityType: "self-entered", createdAt, lastSeenAt }], tripsTotal,
  tripsByStatus, upcomingTrips, interestsTotal, usageByAction,
  usageByIdentity, recentUsage: [last 20 events] }`. Error: `AUTH`.
- The admin section is desktop-only in the UI: it sits behind a settings
  gear icon and is not displayed on mobile at all.

## Data and config

- Spreadsheet "Standby Data", tabs: Trips, Users, Usage, Interested
  (Requests is legacy/unused). Trips carries `trip_type` and `approx`
  columns; the backend creates any missing v3 columns or the Interested
  tab automatically on first call (`ensureSchema_`).
- Sheet timestamps are native dates formatted in America/New_York with AM/PM. API wire timestamps remain ISO for parsing; all displayed times use Eastern.
- Script Properties: `SPREADSHEET_ID`, `ADMIN_PASSWORD`. Set in the Apps
  Script editor under Project Settings. Never commit them anywhere.
- Web app manifest: executes as the deploying account (USER_DEPLOYING),
  access ANYONE_ANONYMOUS so friends do not need a Google account.
  The Sheet itself stays private; all access goes through the script.
- Support email: luna-jd@muse.ai.

## Deploy

1. Copy the repository's latest `apps-script/Code.gs` and
   `apps-script/Index.html` into the **existing** Standby Apps Script
   project. Retain the existing spreadsheet and Script Properties. Do not
   run setupSheet.
2. Save, then Deploy → Manage deployments → edit the current web app →
   New version → Deploy. Preserve its existing execution identity and
   access (anyone with the link, no Google account required).
3. Verify live on desktop and mobile: register/login, PIN change,
   create/edit/delete own trips (delete uses a two-tap in-page confirm —
   the Apps Script sandbox blocks native confirm dialogs), one-way and
   round-trip cards, approximate date/time display, the Interested toggle
   filling and releasing seats, More Info contents, admin hidden on
   mobile and behind the gear on desktop, and the status bar sitting
   flush to the top of the screen while scrolling.

## v4 account and display update

- New accounts use U1, U2, etc. PINs are readable strings, including leading zeros.
- Legacy PIN hashes cannot be reversed. A successful login or an admin reset stores the readable PIN and clears that user's old hash and salt. Empty admin PIN fields mean the old PIN has not yet been converted.
- `apiAdminSetPin(adminToken, userId, pin)` sets a 4–32 character PIN and invalidates that user's existing session. Only authenticated admins can retrieve or edit PINs. Session tokens remain hashed.
- `apiAdminClearBoard(adminToken)` hides open trips and clears interest marks. User accounts remain.
- After copying both source files, run `migrateStandbyV4()` once before publishing the new deployment. It updates IDs and linked ownership, sets the sheet timezone, and converts timestamp cells. It is safe to rerun. Keep existing Script Properties and the same deployment URL.
- Run `node tests/backend.cjs` for backend regression and script syntax checks.
- `previews/index.html` compares Midnight Dispatch plus five alternate mobile skins. These use mock data only.

The live board was reset to three clearly labeled walkthrough trips: Potsdam–Syracuse (one-way, exact, empty), Canton–Watertown (round trip, approximate, one interested), and Norwood–Plattsburgh (one-way, full, pickup unspecified). All three belong to JD Meyers for editing. Historical trips are soft-deleted.
