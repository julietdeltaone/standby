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
