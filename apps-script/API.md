# Standby backend API (Apps Script)

The web app serves `Index.html` from Apps Script HTML Service. The page (and
any future GitHub Pages front door that links or redirects here) calls the
functions below with `google.script.run`. There is no REST endpoint in v1 and
no cross-origin fetch; everything runs inside the Apps Script page.

Every function returns one of:

- `{ ok: true, data: { ... } }`
- `{ ok: false, code: "CODE", error: "Human-readable message" }`

Functions never throw across `google.script.run`; catch failures with
`withFailureHandler` only for transport-level errors.

## Identity

- `apiRegister(name, pin)` → `{ user: { id, name }, token }`
  Errors: `BAD_NAME`, `BAD_PIN`, `NAME_TAKEN`.
- `apiLogin(name, pin)` → `{ user: { id, name }, token }` (rotates the token;
  the old token stops working). Errors: `NO_SUCH_USER`, `BAD_PIN`.
- The client stores `token` (localStorage) and passes it as the first
  argument to every other call. The server resolves the user from the token
  hash. Display names and user ids sent by the client are never trusted.
- Identity types in usage stats: `anonymous` (no token), `self-entered`
  (name + PIN account), `admin`. There is no verified identity in v1.

## Trips and requests

- `apiListTrips(tokenOrEmpty)` → `{ trips: [Trip], me: { id, name } | null }`.
  Only open trips departing in the future, sorted by departure.
  Trip: `{ tripId, driverName, mine, origin, destination, departAt (ISO UTC),
  departDisplay (America/New_York), pickup, seatsTotal, seatsTaken,
  seatsLeft, note, status, myRequest: { requestId, status } | null }`.
- `apiCreateTrip(token, trip)` → `{ tripId }`.
  `trip`: `{ origin, destination, pickup, note, seatsTotal (1-8),
  departLocal: "yyyy-MM-ddTHH:mm" }`. `departLocal` is wall time in
  America/New_York (parsed server-side). (`departEpochMs` is also accepted.)
  Errors: `AUTH`, `BAD_TRIP`, `PAST_DEPARTURE`.
- `apiCancelTrip(token, tripId)` → `{ tripId }`. Driver only; also cancels
  the trip's pending and approved requests.
  Errors: `AUTH`, `NOT_FOUND`, `NOT_OWNER`, `NOT_OPEN`.
- `apiRequestSeat(token, tripId)` → `{ requestId, status: "pending" }`.
  Errors: `AUTH`, `NOT_FOUND`, `NOT_OPEN`, `PAST_DEPARTURE`, `OWN_TRIP`,
  `DUPLICATE` (an active pending or approved request already exists).
- `apiCancelRequest(token, requestId)` → `{ requestId }`. Rider only; if the
  request was approved, the seat is released.
  Errors: `AUTH`, `NOT_FOUND`, `NOT_OWNER`, `NOT_ACTIVE`.
- `apiDecideRequest(token, requestId, decision)` where decision is
  `"approve"` or `"decline"` → `{ requestId, status }`. Driver only.
  Approval runs under a script lock and re-checks capacity inside the lock,
  so simultaneous approvals cannot overbook.
  Errors: `AUTH`, `BAD_DECISION`, `NOT_FOUND`, `NOT_OWNER`, `NOT_PENDING`,
  `TRIP_FULL`.
- `apiMyStuff(token)` → `{ myTrips: [Trip + { requests: [{ requestId,
  riderName, status, createdAt }] }], myRequests: [{ requestId, status,
  createdAt, trip: Trip }] }`. Error: `AUTH`.

## Admin

- `apiAdminLogin(password)` → `{ adminToken }` (valid 2 hours, kept in the
  script cache). The password itself lives only in Script Properties
  (`ADMIN_PASSWORD`); it is not in this repository or the client code.
  Errors: `NOT_CONFIGURED`, `BAD_PASSWORD`.
- `apiAdminStats(adminToken)` → `{ usersTotal, users: [{ name,
  identityType: "self-entered", createdAt, lastSeenAt }], tripsTotal,
  tripsByStatus, upcomingTrips, requestsTotal, requestsByStatus,
  usageByAction, usageByIdentity, recentUsage: [last 20 events] }`.
  Error: `AUTH`.

## Data and config

- Spreadsheet "Standby Data", tabs: Trips, Requests, Users, Usage.
  Storage timestamps are ISO 8601 UTC; display times are America/New_York.
- Script Properties: `SPREADSHEET_ID`, `ADMIN_PASSWORD`. Set in the Apps
  Script editor under Project Settings. Never commit them anywhere.
- Web app manifest: executes as the deploying account (USER_DEPLOYING),
  access ANYONE_ANONYMOUS so friends do not need a Google account.
  The Sheet itself stays private; all access goes through the script.

## Interface update: November 25, 2026

- `apiEditTrip(token, tripId, trip)` accepts the same fields as creation.
  Only the owner can edit an upcoming open trip. Total capacity must be an
  integer from 1–8 and cannot drop below approved riders. Existing requests
  remain attached. The UI reminds the driver to tell riders about changes.
- `apiDeleteTrip(token, tripId)` is owner-only, marks the trip `deleted`,
  cancels pending/approved requests, and clears occupied capacity. Deleted
  trips disappear from the driver's list; the private Sheet retains history.
- `apiChangePin(token, currentPin, newPin)` verifies the current PIN, accepts
  4–32 characters, changes the salt/hash, and returns `{token}` for the new
  session. The prior token is invalidated.
- `Trip` now includes `departLocal` for Eastern-time editing.
- Admin dashboard uses the existing statistics endpoint. Page visits and
  identity breakdowns are events, not unique visitor counts.
- UI map loads Leaflet 1.9.4 and OpenStreetMap tiles only when requested.
  Known town centers have a straight connecting line, not a road route.
  Unrecognized locations show an explanatory fallback, never guessed points.
- Support email: luna-jd@muse.ai.

## Deploy this update (Luna)

1. Copy the repository's latest `apps-script/Code.gs` and
   `apps-script/Index.html` into the **existing** Standby Apps Script project.
   Retain the existing spreadsheet and Script Properties. Do not run setupSheet.
2. Save, then Deploy → Manage deployments → edit the current web app →
   New version → Deploy. Preserve its existing execution identity and access.
   The requested audience is anyone with the link, including visitors without
   a Google account; verify the existing deployment actually permits this.
3. Return the deployed `/exec` URL and deployment version/commit to ChatGPT.
4. Verify mobile and desktop layouts, registration/login, PIN changes,
   create/edit/delete own trips, rider request/cancel, driver approve/decline,
   admin statistics, email link, and supported/unsupported map locations.
   Verify another account cannot mutate the owner's trip. Use clearly marked
   test records and remove them through the app when finished.

Local validation: `node tests/backend.cjs` runs mocked Apps Script behavioral
checks. It does not substitute for live deployment or browser validation.
