# Intercom — submission instructions

Real, self-serve, deploy-then-register — Intercom apps are created and
configured through the Developer Hub's web UI against a real Intercom
account (paid or a free development workspace), pointed at a webhook server
you deploy and own. There is no PR/repo submission process for a private
app (unlike the Dagster submission in this batch) and no CLI/manifest-file
flow (unlike the Zendesk submission in this batch) — the Developer Hub *is*
the registration and configuration surface.

## What's here

```
server.js                  Express server implementing the real Canvas Kit
                            /initialize and /submit webhook contract,
                            X-Body-Signature verification, and the
                            server-side Anakin API client — now 9 of
                            Anakin's 21 REST capabilities (url-scraper,
                            search, agentic-search, map, crawl,
                            wire_discover/catalog/read_action,
                            monitor_list/changes). Ground truth for the
                            original three: anakin-py/src/anakin/client.py
                            and models.py. Ground truth for the six added
                            in this change: anakin-mcp/src/client.ts and
                            anakin-mcp/src/tools/{wire,monitor}.ts, plus
                            live curl testing against api.anakin.io/v1 —
                            see README.md's "Anakin API ground truth"
                            section for two real field-shape discrepancies
                            that testing caught and fixed.
intercom-app-config.json   Reference values for the Developer Hub dashboard
                            fields — not a file Intercom reads.
package.json                express only, no build step.
.env.example                ANAKIN_API_KEY / ANAKIN_BASE_URL /
                            INTERCOM_CLIENT_SECRET / PORT.
test/smoke.test.js          30 node:test cases against this server's own
                            responses, no network/account required (two
                            regression tests stub global.fetch to prove a
                            specific bug fix; every other test is fully
                            offline).
```

Every Canvas Kit structure claim in README.md was checked against a real
Intercom docs page or tutorial fetched live this session (URLs cited inline
in README.md's "Canvas Kit structure confirmed from source" section) — not
assumed or reconstructed from memory. Two initial doc URLs given in the
original task brief
(`developers.intercom.com/docs/references/rest-api/canvas-kit` and
`developers.intercom.com/docs/build-an-integration`) both 404'd; the correct,
current URLs were found via web search
(`developers.intercom.com/docs/canvas-kit`,
`developers.intercom.com/docs/build-an-integration/getting-started/
build-an-app-for-your-inbox`) and used instead — flagging this since it
means the brief's own doc links were stale, not that Canvas Kit itself
doesn't exist or was reinterpreted.

## The one real design question in this task, answered from source

**Is Intercom's app model client-side JS calling Anakin directly (like
Zendesk's iframe), or server-side JSON returned from a webhook?** The task
brief itself predicted server-side/webhook-driven and asked for this to be
confirmed rather than assumed. Confirmed directly:
`developers.intercom.com/docs/canvas-kit.md` states Canvas Kit apps work by
Intercom sending "POST requests to the URLs you provide," and you "respond
to these POST requests with JSON objects" — no client-side script tag, no
iframe asset, nothing analogous to `zaf_sdk.min.js` or `assets/iframe.html`
in `../zendesk-anakin`. The "Building an Inbox App with Canvas Kit" tutorial
(fetched in full) builds exactly this: an Express server with `/initialize`
and `/submit` handlers, which is the pattern `server.js` follows directly —
right down to reading `request.body.component_id` to route logic, the same
field name and dispatch style the tutorial's own example code uses.

This resolves the auth/CORS question differently than Zendesk, too: since
there's no browser context at all, `ANAKIN_API_KEY` sits in this server's
own environment and is attached server-side on every `fetch()` call to
`api.anakin.io` — no proxy trick, no `secure: true` parameter, no CORS
question to ask, because the request that reaches Anakin's API was never
going to originate from a browser in this architecture.

## Verified, not assumed

- **`node --check server.js` and `node --check test/smoke.test.js`** — both
  exit 0.
- **`npm install` actually run** — real `npm install` in this sandbox,
  `express@^5.2.1` resolved and installed (67 packages, 0 vulnerabilities),
  not assumed to work.
- **`npm test` (node:test) actually run — 30/30 pass** (10 original + 20
  added in this change) — covers, for every action (Scrape, AI Search,
  Agentic Search, Crawl, Map, Wire, Monitors): initialize returns a valid
  canvas with the full seven-action list; unknown `component_id` falls back
  to home instead of 500ing; each `pick_*` form renders its expected
  input/button ids; empty-required-field submits return an error canvas,
  not a crash; every `*_poll` and dynamic-id handler (`wire_pick_N`,
  `wire_catalog_pick_N`, `monitor_pick_N`) degrades to a recoverable error
  canvas when its `stored_data` reference is missing; invalid-JSON-schema
  and invalid-JSON-params submits are rejected before any Anakin call;
  missing `ANAKIN_API_KEY` is handled as a clean, single-`go_home` error
  canvas across every new network-calling route, not just the original
  Scrape path; `/healthz` reports key configuration; signature verification
  both rejects a bad `X-Body-Signature` and accepts a correctly HMAC'd one;
  two dedicated regression tests (below) stub `global.fetch` to prove the
  Wire error-envelope bug fix and the `AUTH_REQUIRED` → "Connect account"
  button behavior against a *simulated* real HTTP response, not just
  hand-traced code.
- **The server was actually started and curled against real HTTP, not just
  exercised in-process via node:test** — `node server.js` on a real port,
  then `curl -X POST http://127.0.0.1:.../canvas/initialize` and
  `/canvas/submit` with realistic Intercom-shaped request bodies
  (`workspace_id`, `conversation.id`, `component_id`, `input_values`,
  `current_canvas.stored_data`) for every screen, original and new: home
  (confirmed all 7 action ids present), scrape/search/agentic/crawl/map/wire
  forms, the Wire discover→sites→catalog→run chain, and the `go_home`
  reset — every response was valid JSON with a well-formed
  `canvas.content.components` array.
- **Real network round trips to `https://api.anakin.io/v1` happened for every
  new endpoint, not just the original three** — with a real (fake-valued,
  no real credits) API key set, curled live:
  - `GET /wire/catalog` (no slug) — returned real data: 50+ real site
    catalogs (1-800-Flowers, 101 Cookbooks, 123inkt, …) with real
    `action_count`s. This is what caught the `{catalog: [...]}` vs.
    guessed-`catalogs` key bug — see README.md.
  - `GET /wire/catalog/1800flowers` (a real slug from the above) — returned
    9 real actions, correctly split 3 read / 6 write by this app's `type`
    filter, with real parameter schemas (e.g. `Product Questions` needing a
    `product_id: string, required`).
  - `GET /wire/resolve?q=track+my+package` and `q=check+order+status+on+
    toasttab` — both returned real, non-empty candidate lists spanning
    multiple real catalogs (`airnavradar`, `beatport`, `nytimes`, `toasttab`,
    `nasstatus-faa-gov`, …), correctly grouped and rendered as a
    site-disambiguation screen. This is what caught the missing `type`
    field on resolve results — see README.md's "Scope: Wire read actions
    only."
  - `POST /wire/task` with a fake key against a real action id — returned
    `{"error":{"code":"UNAUTHORIZED","message":"Invalid API key."}}`,
    rendered by this app as `"Invalid API key."`, not `"[object Object]"` —
    the direct proof the nested-error-envelope fix works against the real
    API, not just a hand-written test fixture.
  - `POST /crawl`, `POST /map`, `GET /monitors` with a fake key — each
    returned `{"error":"unauthorized","message":"Invalid or inactive API
    key"}`; this app now shows the more descriptive `"Invalid or inactive
    API key"` (previously would have shown the terser `"unauthorized"`).
  Together these prove the server-side HTTP client, headers, base URL, and
  error-path handling are wired correctly end-to-end against the real API
  for the new endpoints just as they already were for the original three —
  it does not prove a successful *completed* job (crawl/map/wire results,
  monitor changes) renders correctly, since no real credits were spent (see
  "Not done").
- **`X-Body-Signature` verification was curled against real HTTP with a real
  HMAC** — with `INTERCOM_CLIENT_SECRET=test-secret` set: no header → 401;
  wrong header (`deadbeef`) → 401; header computed with
  `openssl dgst -sha256 -hmac test-secret` over the exact request body → 200.
  This is the actual verification algorithm exercised against a real
  HMAC implementation (OpenSSL), not just this server's own code checking
  itself.
- **Real bugs found and fixed by curl-testing, not just written and assumed
  correct**:
  1. (Original session) The top-level `/canvas/submit` catch-all error
     handler passed `retryId: "go_home"` into `errorCanvas()`, which already
     appends its own `go_home` button — two components with the same `id`
     in one canvas. Fixed; regression test guards it.
  2. (This change) `anakinRequest()`'s error-body parsing only handled the
     flat `{error: "msg"}` shape; against Wire's real nested
     `{error: {code, message}}` envelope it rendered `"[object Object]"`.
     Fixed to branch on whether `body.error` is a string or object, mirroring
     `anakin-mcp/src/client.ts`'s own `toError()`. Regression test:
     `test/smoke.test.js`, "surfaces Wire's nested error envelope message
     correctly."
  3. (This change) Same function, flat-shape branch: a real
     `{"error":"unauthorized","message":"..."}"` response was rendering the
     terse `error` field instead of the more descriptive sibling `message`
     field. Fixed to prefer `message` when present.
  4. (This change) `GET /wire/catalog`'s real response key is `catalog`
     (singular), not `catalogs` — the initial guess silently rendered
     "No catalogs returned" against real data. Fixed by curling the live
     endpoint and adding the correct key.
  5. (This change) `GET /wire/resolve` results don't reliably include a
     `type` (read/write) field, contradicting what would otherwise have been
     assumed from `wire.ts`'s tool description. Rather than patch around
     it, this drove a real design change — see README.md's "Scope: Wire
     read actions only."
  `assertValidCanvas` in the test helper (already strengthened during the
  original session to reject duplicate component ids) continues to guard
  every screen added in this change too.
- **Response shapes for `/url-scraper`, `/search`, `/agentic-search`** — read
  directly from `anakin-py/src/anakin/client.py` and `models.py`, as in the
  original session.
- **Response shapes for `/map`, `/crawl`, `/wire/*`, `/monitors/*`** — read
  from `anakin-mcp/src/client.ts` and `anakin-mcp/src/tools/{wire,
  monitor}.ts`, then corrected against live API responses where the source
  file's own typing was too loose to fully pin down field names (`Record
  <string, unknown>` / `unknown`) — see the "Real bugs found" list above and
  README.md's "Anakin API ground truth" section.
- **Canvas Kit component/request/response field names** — see README.md's
  "Canvas Kit structure confirmed from source" section for the specific
  live-fetched doc page backing each one (Text, Button, Input, Checkbox,
  List/item, action types, Canvas response shape, request fields).

## Not done

- **Never created a real app in a real Intercom Developer Hub, and never
  registered these webhook URLs against one** — no Intercom account exists
  in this environment. Everything above was verified by running this
  server standalone and sending it realistically-shaped requests by hand
  (`curl`), which proves the webhook *contract* is implemented correctly,
  but not that Intercom's actual servers accept and drive it the same way
  end-to-end.
- **Never deployed this server to a public HTTPS URL** — ran only on
  `127.0.0.1` in this sandbox. Deploying somewhere with a real TLS
  certificate is a prerequisite for step 3 in README.md's "Steps," since
  Developer Hub webhook URLs must be HTTPS.
- **Never exercised a real Anakin API key end-to-end through a full
  scrape/search/agentic-search/crawl/map/wire/monitor job to completion** —
  no real `ANAKIN_API_KEY` was available in this environment (same
  limitation noted in `../zendesk-anakin/SUBMIT.md`'s "Not done"). What
  *was* verified: a fake key correctly produces real, well-handled error
  responses from every endpoint this app calls, including the newly added
  ones (see "Verified, not assumed" above for the specific curled
  responses) — proving every request path is wired right, not that a
  successful response is handled correctly. `server.js`'s success-path
  rendering (`scrapeResultScreen`, `searchResultScreen`,
  `agenticResultScreen`, `crawlResultScreen`, `mapResultScreen`,
  `wireActionResultScreen`, `monitorChangesScreen`) was checked by
  hand-tracing against real field names — for map/crawl/wire, those field
  names come from a mix of `anakin-mcp/src/client.ts`'s typed interfaces
  (`MapResult`, `CrawlResult`) and, for Wire and monitors, real (but
  unauthenticated, error-terminated) live responses rather than a completed
  job's payload — not by observing an actual completed job's success shape.
- **Monitor changes' exact field names (`detectedAt`/`createdAt`/
  `timestamp`, `summary`/`description`/`diff`) were never confirmed against
  a real monitor** — `GET /monitors` and `GET /monitors/:id/changes` both
  return `401` with the fake test key used in this session (no monitor ever
  existed to fetch changes for), so `monitorChangesScreen()`'s field
  fallback chain is written defensively (the same style used throughout
  this file for exactly this reason) but untested against a real payload.
  If the account owner creates a monitor and it detects a change, worth a
  quick sanity curl against the real response before relying on this
  screen's exact wording.
- **Wire's `wire_login`/`wire_identities` are not implemented, so any
  `AUTH_REQUIRED` action always ends at the "Connect account" link** — this
  is the intended, documented scope (see README.md's "Coverage decisions"),
  not a gap, but it does mean a support agent can discover an
  authentication-required action and see its connect link, but can never
  complete a lookup through it without leaving this app to connect the
  account first (a one-time setup, not a per-conversation step, so this was
  judged acceptable rather than building credential management into a
  support sidebar).
- **`card_creation_options` / one-tap "insert into reply" was not
  implemented** — confirmed to be a real, documented mechanism (see
  README.md's "Inserting into the reply composer" section for the citation)
  but its full contract (the separate "configure" flow webhook, the exact
  shape of the resulting inserted card) wasn't confirmed with a complete
  worked example from the docs reached in this session. Implementing it
  without that confirmation would mean guessing at unverified request/
  response fields for a production submission — flagged as follow-up
  work instead of guessed at.
- **`textarea` component's dedicated reference page wasn't independently
  fetched** — confirmed to exist as a component type from the Canvas Kit
  overview page's component list, but its exact field shape here is
  inferred from the (fetched, confirmed) Input component's shape rather
  than from its own reference page. Every other component type used
  (Text, Button, Input, Checkbox, List/item) was checked against its own
  dedicated reference page.
- **No app icon/brand assets, no App Store listing copy** — this
  submission is the webhook server and its Developer Hub configuration
  values only. Icon/screenshots/listing copy are needed before public App
  Store submission per Intercom's own review flow, not before a private
  workspace install.
- **HMAC verification was exercised with a synthetic test secret
  (`test-secret`), not a real Developer Hub-issued OAuth client secret** —
  the algorithm and code path are proven correct (see "Verified, not
  assumed"), but the actual secret value that would be issued to a real
  registered app was never generated or used, since no real app was
  created.

## Steps (needs the account owner)

1. Create an app in a real Intercom workspace's Developer Hub.
2. Deploy `server.js` to a public HTTPS host; set `ANAKIN_API_KEY` (real
   key from [anakin.io/dashboard](https://anakin.io/dashboard)) and
   `INTERCOM_CLIENT_SECRET` (from that app's Developer Hub > Configure >
   Authentication page) as environment variables.
3. In Developer Hub > Configure > Canvas Kit > For teammates, check "Add to
   conversation details," paste in the Initialize and Submit webhook URLs
   (`intercom-app-config.json` has the exact field-by-field reference).
4. Open a real conversation in the Inbox, pin the app to the sidebar, and
   exercise all three actions (Scrape URL, AI Search, Agentic Search)
   against live data end to end — the one thing this session couldn't
   check, per "Not done" above.
5. For a public App Store listing: add an icon and screenshots and submit
   for review through the Developer Hub's own review flow.
