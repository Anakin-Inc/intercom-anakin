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
                            server-side Anakin API client (url-scraper,
                            search, agentic-search — ground truth read from
                            anakin-py/src/anakin/client.py and models.py).
intercom-app-config.json   Reference values for the Developer Hub dashboard
                            fields — not a file Intercom reads.
package.json                express only, no build step.
.env.example                ANAKIN_API_KEY / ANAKIN_BASE_URL /
                            INTERCOM_CLIENT_SECRET / PORT.
test/smoke.test.js          9 node:test cases against this server's own
                            responses, no network/account required.
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
- **`npm test` (node:test) actually run — 10/10 pass** — covers: initialize
  returns a valid canvas with the three-action list; unknown `component_id`
  falls back to home instead of 500ing; `pick_scrape` returns the scrape
  form with the right input/button ids; empty-URL submit returns an error
  canvas, not a crash; `scrape_poll` with no `stored_data.job_id` degrades
  gracefully; invalid-JSON-schema agentic submit is rejected before any
  Anakin call; missing `ANAKIN_API_KEY` is handled as a clean error canvas
  with no duplicate component ids (see next bullet); `/healthz` reports key
  configuration; signature verification both rejects a bad
  `X-Body-Signature` and accepts a correctly HMAC'd one.
- **The server was actually started and curled against real HTTP, not just
  exercised in-process via node:test** — `node server.js` on a real port,
  then `curl -X POST http://127.0.0.1:.../canvas/initialize` and
  `/canvas/submit` with realistic Intercom-shaped request bodies
  (`workspace_id`, `conversation.id`, `component_id`, `input_values`,
  `current_canvas.stored_data`) for every screen: home, scrape form, search
  form, agentic form, and the `go_home` reset — every response was valid
  JSON with a well-formed `canvas.content.components` array.
- **A real network round trip to `https://api.anakin.io/v1` happened and was
  correctly handled** — `scrape_submit` and `scrape_poll` were curled with a
  deliberately fake API key; both produced a real HTTP response from the
  live Anakin API (`"Invalid or inactive API key"`), which this server
  turned into a well-formed Canvas Kit error screen rather than crashing or
  leaking a stack trace. This proves the server-side HTTP client, header
  (`X-API-Key`), base URL, and error-path handling are wired correctly
  end-to-end against the real API — it does not prove a successful job
  completes, since no real Anakin API key was exercised (see "Not done").
- **`X-Body-Signature` verification was curled against real HTTP with a real
  HMAC** — with `INTERCOM_CLIENT_SECRET=test-secret` set: no header → 401;
  wrong header (`deadbeef`) → 401; header computed with
  `openssl dgst -sha256 -hmac test-secret` over the exact request body → 200.
  This is the actual verification algorithm exercised against a real
  HMAC implementation (OpenSSL), not just this server's own code checking
  itself.
- **A real bug was found and fixed by this curl testing, not just written
  and assumed correct**: the top-level `/canvas/submit` catch-all error
  handler originally passed `retryId: "go_home"` into `errorCanvas()`, which
  already appends its own `go_home` button — producing two components with
  the same `id` in one canvas (found via curling `scrape_submit` with a real
  URL against the missing-API-key path). Fixed in `server.js`, and a
  regression test (`test/smoke.test.js`, "no ANAKIN_API_KEY configured
  returns a single-go_home error canvas") now guards it. `assertValidCanvas`
  in the test helper was also strengthened to assert no duplicate component
  ids in any canvas, catching this whole bug class going forward.
- **Response shapes for `/url-scraper`, `/search`, `/agentic-search` (submit
  body fields, job-id field names `jobId`/`job_id`/`id`, poll status values
  `completed`/`failed`, `generatedJson.summary`/`structuredData`)** — read
  directly from `anakin-py/src/anakin/client.py` (`scrape()`, `search()`,
  `agentic_search()` methods and their `_require_job_id`/`_is_job_terminal`
  helpers) and `anakin-py/src/anakin/models.py` (`Document`, `SearchResult`,
  `AgenticSearchResult`, `AgenticSearchData`), not guessed or copied from
  the Zendesk submission's version of the same claim without re-checking.
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
  scrape/search/agentic-search job to completion** — no real
  `ANAKIN_API_KEY` was available in this environment (same limitation noted
  in `../zendesk-anakin/SUBMIT.md`'s "Not done"). What *was* verified: a
  fake key correctly produces a real, well-handled `401` from the live API
  (see "Verified, not assumed" above) — proving the request path is wired
  right, not that a successful response is handled correctly. `server.js`'s
  success-path rendering (`scrapeResultScreen`, `searchResultScreen`,
  `agenticResultScreen`) was checked by hand-tracing against the exact
  field names in `anakin-py`'s response models, not by observing a real
  completed job.
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
