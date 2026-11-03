# hermit-agent: a CSP allow-list for connections (spike, 2026-11-03)

Status: tested, not built. Nothing in `hermit-agent/src/` has changed yet. This note is the
handoff for the session that builds it; the two decisions at the end are the owner's.

## Goal

Today the built file carries `connect-src * blob: data:`, and the only thing that stops
agent code from reaching the network is the worker's network guard (DESIGN §10): a list of
browser APIs it replaces. That is a denylist, so a browser API nobody listed is a way out.

The idea: once the endpoint is known, insert a second, stricter CSP `<meta>` by script,

    connect-src <endpoint origin> https://cdn.jsdelivr.net/pyodide/v0.29.5/full/ blob: data:

before the worker starts. CSP policies stack, so this narrows the existing `connect-src *`,
and the browser enforces the allow-list for every request type, including APIs added later.

## Setup

Scripts in `hermit-agent/spike/csp/` (run with `../benchmark/.venv/bin/python` from the repo root
or by absolute path; they start their own local servers):

- `csp-test.html` + `run.py`: page probes, worker A (started before the insert), worker B
  (started after it), fetch/XHR/WebSocket to an allowed endpoint, a forbidden server (same
  host, other port) and the LAN IP. Pyodide with numpy and pandas from jsDelivr in worker B.
  Pages from `file://`, `http://localhost`, and an https page that Chromium is told to treat
  as public (`--ip-address-space-overrides`, `local-network-access` granted). Endpoint on
  loopback and on the LAN IP. A few minutes per run.
- `path.py`: the CDN entry restricted to the pinned Pyodide path.
- `attack.html` + `attack.py`: attacks from a locked worker, and from the page itself.
  About 30 s.

The servers' hit logs are the ground truth, not the browsers' error messages.
Browsers: Playwright Chromium 149.0.7827.55 and Firefox 151.0.

## Results

| Question | Chromium | Firefox |
|---|---|---|
| (a) Inserted `<meta>` enforced on later fetch, XHR, WebSocket from the page | yes | yes |
| (b) Worker started after the insert inherits it | yes | yes |
| (b) Worker started before the insert | fully unrestricted | partly: XHR blocked, fetch and WebSocket still got out |
| (c) `securitypolicyviolation` fires, with `blockedURI` | page and worker | page and worker |
| (d) Endpoint fetch, loopback and LAN, from `file://` and `http://localhost` | works | works |
| (e) Pyodide + numpy + pandas from jsDelivr in the locked worker | works, 3.7 s, no violations | works, 10.6 s, no violations |

Details:

- After the insert, neither the forbidden server nor the endpoint not chosen got a single
  request from the page or from worker B.
- The worker has to start after the insert. In Firefox a worker that already runs keeps
  fetch and WebSocket.
- `ws://` is blocked even to the endpoint's own origin: an `http://host:port` source does not
  cover it. The app uses no WebSocket, so this only makes it stricter.
- A path works as the CDN source. `https://cdn.jsdelivr.net/pyodide/v0.29.5/full/` lets Pyodide
  and its packages load and blocks `cdn.jsdelivr.net/npm/...` in both engines. jsDelivr also
  serves arbitrary npm and GitHub content, so use the path, not the host.
- `blockedURI` is the full URL, query included. Show only the origin in the UI.
- A violation event from the worker is forgeable by agent code: fine to display, never to
  decide anything on.
- Not proved for (d): the real case of an https page (GitHub Pages) reaching a LAN endpoint
  through Chrome's Local Network Access. With the override flag and the granted permission
  the page's fetch with `targetAddressSpace` worked, but the run can't show the flag took
  effect, and a real permission prompt from a public page was not tested. CSP checks the URL
  before LNA, so they shouldn't interact; still check it by hand on the Pages build. Firefox
  blocks https page to LAN http with or without the CSP (mixed content).

## Attacks (`attack.py`)

From a worker started after the lock, every attempt failed in both engines and the
attacker's server got no request from the worker:
fetch (plain, `no-cors`, `keepalive` POST), sync XHR, WebSocket, EventSource, WebTransport,
`importScripts`, dynamic `import()`, a nested blob worker (it inherits the lock), a `data:`
worker (refused), and a redirect through the endpoint (the endpoint got the request, the
redirect to the attacker's host was blocked). `RTCPeerConnection` and `sendBeacon` don't
exist in workers.

A session file can't widen the list: `importSessionFile` keeps the current connection
settings and only mentions the session's `apiUrl`.

What it doesn't stop:

1. The allowed hosts. Agent code can send data to the endpoint (the user's own server, which
   sees the chat anyway; the worker never has the API key) and put data into a URL under the
   pinned jsDelivr path (it went out, jsDelivr answered 403; only jsDelivr's logs see it). The
   JS guard still blocks both inside the worker.
2. Order. A worker started before the lock is not locked (Firefox, above).
3. Code running in the page itself. Removing the `<meta>` does not lift the policy (both
   engines), and image beacons, `sendBeacon` and iframes didn't reach the attacker. But in
   Chromium `<link rel=prefetch>` reached the attacker's server and WebRTC sent 4 STUN packets
   to it over UDP; Firefox sent neither. Top-level navigation (`location = ...`) was not
   tested and is outside CSP anyway. Not today's threat: agent code runs only in the worker,
   the page validates worker messages and never evaluates them, `eval` is blocked, and
   DOMPurify 3.4.12 drops `<link>` from model output.
4. A link the model writes can carry data in its URL if the user clicks it. Unrelated to this
   CSP; remote images are already blocked by `img-src`.
5. Browser bugs in CSP enforcement.

Fair claim for DESIGN §10 and the UI: code in the worker can reach only the endpoint and the
pinned Pyodide path, enforced by the browser and tested in both engines. Not "no network"
for the page as a whole.

## Plan for the real change

1. `lockConnections(endpointUrl)` inserts
   `connect-src <endpoint origin> <PYODIDE_CDN> blob: data:`; the offline builds list the
   endpoint only. It runs at endpoint save and before the first `startWorker`. No worker may
   exist before it; if one does, restart it.
2. The policy can't be loosened, so an endpoint change to another origin after the lock
   offers "Export session, then reload". Test Connection and the model list for a new origin
   give the same hint. Test Connection before the first lock must still work for any URL.
3. Allow network re-run reaches only the endpoint and the pinned CDN path (see decision 1).
   Blocked attempts show in the step card, origin only (worker listener for
   `securitypolicyviolation`, a validated message to the page).
4. The unbuilt `src/index.html` also needs `https://files.pythonhosted.org` in that list: the
   dev source downloads the bundled wheels from PyPI (`loadBundledWheel`); the built file
   inlines them.
5. DESIGN §10 gets the measured claim and the residuals above.
6. `e2e_network.py`: a re-run with network allowed (JS guard open) tries a host outside the
   list; the CSP must block it, the server must get no hit, and the step card must show the
   attempt. Add a check that no worker starts before the lock. The worker attacks in
   `attack.html` can move into it.

## Decisions for the owner

1. Allow network re-runs lose their main use under the lock (reading a public CORS site,
   `pandas.read_csv(url)`). Recommended: lock only when the setting is off at lock time;
   turning it on later means export and reload. Alternatives: keep the narrow re-run as in
   plan step 3, or drop the setting.
2. Worker code can still reach the endpoint (the guard blocks it, the CSP doesn't).
   Recommended: accept it, since the worker has no key, and say so in DESIGN §10.
