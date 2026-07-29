# intercom-anakin

An Intercom Inbox app, built on Intercom's Canvas Kit, that adds
[Anakin](https://anakin.io) — web scraping and crawling, site mapping,
AI-powered search, multi-stage agentic research, live data lookups on
hundreds of sites via Wire, and website-change monitoring — to the
conversation sidebar.

## Not an iframe app — Canvas Kit is webhook-driven

Unlike `../zendesk-anakin` (a static HTML/JS iframe app), an Intercom Canvas
Kit app has **no client-side code at all**. Confirmed by fetching Intercom's
own docs directly (`developers.intercom.com/docs/canvas-kit.md`): "Canvas Kit
enables developers to build applications that operate directly within the
Intercom interface... Intercom sends POST requests to webhook URLs you
configure... You respond with JSON containing `canvas.content`." The UI a
teammate sees is a JSON component tree *your own server* returns in response
to POSTs Intercom's servers make to two webhook URLs you register in the
Developer Hub — confirmed against the "Building an Inbox App with Canvas
Kit" tutor­ial (`developers.intercom.com/docs/build-an-integration/
getting-started/build-an-app-for-your-inbox.md`), whose `/initialize` and
`/submit` Express handler pattern this app's `server.js` follows directly.
This is why this submission is a real Node/Express server, not another
static asset bundle.

## What's covered

This app started (previous session) with the three-endpoint baseline shared
across every single-purpose Anakin integration in this batch. This change
extends it to 9 of Anakin's 21 REST API capabilities — everything a support
agent plausibly needs while looking things up mid-conversation — exposed as
a conversation-sidebar flow driven one action at a time:

- **Scrape a URL** — submits `POST /v1/url-scraper`, then polls
  `GET /v1/url-scraper/:jobId`. Since Canvas Kit request/response is
  synchronous (no server push into an already-rendered canvas), the
  "processing" screen has a **Check status** button the teammate taps again
  rather than the app silently waiting on a job that can take longer than a
  single HTTP round trip — see "Design decision: polling" below.
- **AI Search** — calls `POST /v1/search`. Synchronous, no polling, so this
  is the one action that's a single submit → result round trip. Costs 3
  credits per call.
- **Agentic Search** — submits `POST /v1/agentic-search`, polls
  `GET /v1/agentic-search/:jobId` the same way as Scrape. Shows the
  AI-generated summary plus, if a JSON Schema was supplied, the structured
  data. Costs 10 credits.
- **Crawl a Site** *(new)* — submits `POST /v1/crawl`, polls
  `GET /v1/crawl/:jobId`. Bulk-fetches markdown across several pages of a
  site in one go (e.g. a whole docs section), with optional
  include/exclude path patterns. Shows each page's URL and fetch status;
  taps through to open a page, with a hint to Scrape a specific URL for its
  full text.
- **Map a Site** *(new)* — submits `POST /v1/map`, polls `GET /v1/map/:jobId`.
  Lists a domain's discoverable URLs (internal + optionally external) —
  useful for finding the right page before scraping or crawling it.
- **Find & Run a Site Action (Wire)** *(new)* — `GET /v1/wire/resolve`
  (natural-language discovery), `GET /v1/wire/catalog` and
  `GET /v1/wire/catalog/:slug` (browsing), `POST /v1/wire/task` + poll
  `GET /v1/wire/jobs/:jobId` (execution). Looks up live data — an order, a
  listing, a profile, dashboard data — on any of Wire's hundreds of
  supported sites without writing a scraper. **Read actions only** — see
  "Scope: Wire read actions only" below for why, and for a real bug this
  scoping decision surfaced during live testing.
- **Website Monitors** *(new)* — `GET /v1/monitors` and
  `GET /v1/monitors/:id/changes`. Lets a support agent check whether a
  page they're discussing (a status page, a pricing page, a policy page) is
  being watched and what changed recently. Read-only — this app never
  creates, pauses, or deletes a monitor.

Results are shown as `text` components in the sidebar for the teammate to
select and copy into their reply — see "Inserting into the reply composer"
below for why this app doesn't attempt an automatic insert.

## Coverage decisions: what's in scope for a support-agent sidebar, and why

Anakin's REST API has 21 capabilities total; this app now covers 9. The
remaining 12 were deliberately left out, each for one of two reasons —
"the task brief says skip it" or "it doesn't fit a support agent working one
open conversation":

**Skipped per the task brief** (automation/write surface, not a sidebar
lookup tool):
- `wire_write_action` — state-changing Wire actions (submit a form, add to
  cart). This app's entire Wire integration is scoped to read actions only;
  see below.
- `wire_login` / `wire_identities` — credential management for Wire's
  auth-required actions. No sign-in UI exists in this app; an auth-required
  action surfaces a "Connect account" link (the `connect_url` Wire returns
  on `AUTH_REQUIRED`) instead of attempting to authenticate inline.
- `wire_build` — requests a brand-new scraper for an unlisted site. A
  billed, asynchronous content-generation action, not a lookup.
- `monitor_create` / `monitor_control` (pause/resume/run_now/delete) —
  creating or mutating a recurring, billed background job. A support
  agent reads monitor state (`monitor_list`/`monitor_changes`, both
  included); creating/managing monitors is an admin/ops task for the
  Anakin dashboard, not a per-conversation lookup.
- `session_delete` — irreversibly deletes saved login state used across
  many monitors/crawls, not scoped to one conversation.
- `browser_task` — open-ended natural-language browser automation (clicks,
  form fills, multi-step flows). The task brief's own framing — "a support
  agent's sidebar is mostly about lookups, not automation" — applies most
  directly here; `browser_task` is Anakin's most automation-shaped
  capability of the 21.

**Skipped as out of scope for *this* app's job** (a single support agent
working *this* conversation), even though nothing in the task brief
required skipping them:
- `session_list` — lists saved browser-session IDs used as a `sessionId`
  input to scrape/crawl/monitor_create for login-protected pages. This app
  exposes none of those `sessionId` fields (Scrape's form, for instance,
  never asks for one), so listing session IDs here would hand the teammate
  identifiers with no action to take on them. It is infrastructure
  plumbing for pages behind a login, not conversation-relevant lookup data.
- `ai_visibility_search` / `ai_visibility_sources` — asks multiple AI
  answer engines the same question and compares results, for brand/AI-SEO
  visibility tracking. This is a genuinely useful Anakin capability, but
  it answers "how do AI engines describe our brand in general," not
  anything about *this* customer's *this* conversation — it's a
  marketing/SEO workflow, not a support-conversation lookup, and adding it
  here would dilute the app's single clear job. Flagged, not silently
  dropped: this is the one candidate capability excluded on judgment
  rather than an explicit brief instruction, and it's a reasonable
  candidate for a *separate*, marketing-team-facing Intercom app if one is
  ever built.
- `monitor_get` (fetch one monitor's config by id, distinct from
  `monitor_list`) — `monitor_list`'s response already carries what this
  app's `monitor_pick_N` flow needs (url, active state, interval);
  `monitor_get` returns the same monitor's full config object, which adds
  nothing actionable in a sidebar that never edits a monitor.

## Scope: Wire read actions only

Wire actions are split by `type` into `read` (data extraction — search
listings, fetch a product's price, read a profile) and `write`
(state-changing — submit a form, add to a cart). `anakin-mcp/src/tools/
wire.ts` splits these into two separate MCP tools specifically so a write
action always needs its own explicit safety annotation and confirmation
step; this app follows the same principle by never rendering a write action
as tappable, anywhere.

**A real, live-testing-confirmed complication**: `GET /wire/resolve`'s
results do **not** reliably include a `type` field — a live query
(`q=track my package`) returned candidates shaped like
`{action_id, catalog, credits, auth_required, auth_satisfied, params}`,
with no read/write marker at all. `GET /wire/catalog/:slug`'s `actions[]`,
by contrast, *does* reliably report `type` (confirmed live for the
`1800flowers` catalog: 9 actions, 3 read / 6 write, each correctly typed).
Trusting an absent field on the resolve response as "must be write" (or
"must be read") would be guessing at unconfirmed, safety-relevant API
behavior — exactly what this submission's other files repeatedly say not to
do. So **Find & Run a Site Action never renders a resolve result as directly
runnable**: it groups resolve matches by their `catalog` slug, then always
fetches that site's full catalog entry (which does reliably report `type`)
and filters to `type === "read"` before anything is shown as tappable. One
extra network hop, but it means the "read actions only" guarantee is backed
by a field the API actually returns reliably, not one it doesn't.

## Files

```
server.js                 The whole app: Express server implementing the
                           documented Canvas Kit /initialize and /submit
                           webhook contract, plus signature verification and
                           the server-side Anakin API client.
intercom-app-config.json  Reference values for the Developer Hub's web UI
                           (see "No manifest file" below) — not read by
                           Intercom.
package.json              express only. No build step.
.env.example              ANAKIN_API_KEY / ANAKIN_BASE_URL /
                           INTERCOM_CLIENT_SECRET / PORT.
test/smoke.test.js        node:test suite against this server's own
                           /canvas/* responses — no network, no Anakin key,
                           no Intercom account required.
```

## No manifest file — Developer Hub is a web UI, not a repo artifact

Zendesk apps have a `manifest.json` a real CLI (`zcli`) reads from the repo.
Intercom apps don't: confirmed by web search (found no CLI/manifest-file
mechanism for Intercom apps) and by the "Build an Inbox App" tutorial itself,
which has the developer paste webhook URLs by hand into Developer Hub form
fields ("Configure > Canvas Kit > For teammates > enter your Initialize
endpoint... enter your Submit endpoint"), and by the Developer Hub's own
"tools dashboard" changelog announcement describing it as a web dashboard,
not a file-based app definition. `intercom-app-config.json` in this
directory is this submission's own reference document of every value that
needs typing into that UI — it is not a file Intercom parses.

## Install (local dev)

```sh
npm install
cp .env.example .env   # fill in ANAKIN_API_KEY at minimum
node --env-file=.env server.js
```

Then, per the real tutorial's testing steps: expose this server publicly
(the tutorial uses Replit; `ngrok http 3000` or any tunnel works the same
way), paste `https://<tunnel>/canvas/initialize` and
`https://<tunnel>/canvas/submit` into Developer Hub > Configure > Canvas Kit
> For teammates > "Add to conversation details", open a real conversation in
a real Intercom Inbox, and pin the app to the sidebar.

## Auth: the Anakin API key never leaves this server

`ANAKIN_API_KEY` is read from the server process's environment
(`process.env.ANAKIN_API_KEY`) and sent as the `X-API-Key` header on every
call to `https://api.anakin.io/v1`. Because Canvas Kit apps have no
client-side code — the entire premise of this integration model — there is
no browser context for the key to leak into in the first place; this is a
stronger guarantee than Zendesk's `secure: true` parameter mechanism (which
still has to actively prevent a value from reaching an iframe that otherwise
could see it). See `server.js`'s `anakinRequest()`.

## Verifying requests are really from Intercom

`developers.intercom.com/docs/canvas-kit`: "Each request includes an
`X-Body-Signature` header using HMAC-SHA256 for verification against your
OAuth client secret." `server.js`'s `verifySignature()` computes
`HMAC-SHA256(rawRequestBody, INTERCOM_CLIENT_SECRET)` as a hex digest and
compares it to the header value with `crypto.timingSafeEqual` (not `===`,
to avoid a timing side-channel on the comparison itself). The raw body is
captured via `express.json()`'s `verify` callback rather than re-serializing
`req.body`, since JSON.stringify key-ordering/whitespace could otherwise
produce a byte-different string than what Intercom actually HMAC'd. If
`INTERCOM_CLIENT_SECRET` isn't set, verification is skipped with a logged
warning — deliberate, so this server can be smoke-tested/curled locally
without registering a real Intercom app first, but flagged loudly because
it's genuinely unsafe to run that way against a public URL.

## Design decision: polling instead of blocking

Canvas Kit's `/submit` webhook is a synchronous request/response — there's
no documented mechanism for this server to push an updated canvas into an
already-open sidebar once a job finishes later. Two options: (a) block the
HTTP response until the Anakin job completes (risking timing out if a job
runs long — no documented Canvas Kit webhook timeout was found to design
against precisely, which is itself a reason not to gamble on it), or (b)
respond immediately with a "processing" canvas plus a **Check status**
button that re-submits to the same job. This app does (b): `stored_data` on
the canvas response — confirmed via
`developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas`
("stored_data... key-value pairs retained across requests") — carries the
Anakin `job_id` forward, and comes back as `current_canvas.stored_data` on
the teammate's next tap, so `scrape_poll` / `agentic_poll` know which job to
check without re-deriving it.

## Inserting into the reply composer — confirmed to exist, not implemented

Zendesk's ZAF apps have a documented, simple mechanism for this
(`client.invoke('comment.appendText', ...)`), used in `../zendesk-anakin`.
Intercom's equivalent is real but more involved: conversation-details apps
can be configured to insert a card into the reply via a `card_creation_options`
object sent to the initialize webhook after a separate "configure" flow —
confirmed to exist as a documented mechanism
(`developers.intercom.com/docs/references/1.1/canvas-kit/requestobjects/
card-creation-options`), but its full request/response contract (the
"configure" webhook's own shape, exactly how the resulting card lands in the
composer) wasn't confirmed with a complete worked example from the docs
reachable in this session. Rather than guess at an unconfirmed contract and
risk shipping fabricated behavior, this app instead shows results as
selectable `text` components with an explicit "Select and copy the text
above into your reply" hint — a smaller, fully-documented feature surface
that still gets the teammate's information in front of them. Wiring up
`card_creation_options` for one-tap insert is flagged as follow-up work in
SUBMIT.md, not silently skipped.

## Canvas Kit structure confirmed from source

Every component/field shape used in `server.js` was checked against a real,
live Intercom docs page fetched directly this session, not reconstructed
from memory:

- **Canvas Kit is webhook-driven, no client-side code** —
  `developers.intercom.com/docs/canvas-kit.md`.
- **Initialize/Submit webhook flow, `component_id`-based routing pattern** —
  `developers.intercom.com/docs/build-an-integration/getting-started/
  build-an-app-for-your-inbox.md` (full tutorial with example Express
  handlers, fetched in full).
- **Request fields `current_canvas`, `input_values`, `component_id`,
  `conversation` (Inbox only)** — Canvas Kit request-object reference pages
  (`requestobjects/current-canvas`, `requestobjects/input-values`) plus the
  inbox tutorial's own request-body description.
- **Canvas response shape (`canvas.content.components`, `canvas.stored_data`,
  64KB size limit, `stored_data` optional)** —
  `developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas`.
- **Text component** (`type`, `text`, `id`, `align`, `style` enum
  `header`/`paragraph`/`muted`/`error`, Markdown support for links/bold) —
  `docs/references/1.1/canvas-kit/presentationcomponents/text`.
- **Button component** (`type`, `id`, `label`, `style` enum
  `primary`/`secondary`/`link`, `action`, `disabled`) —
  `docs/references/1.1/canvas-kit/interactivecomponents/button`.
- **Input component** (`type`, `id`, `label`, `placeholder`, `value`,
  `save_state`, `disabled`, `action`) —
  `docs/references/canvas-kit/interactivecomponents/input`.
- **Checkbox component** (`type`, `id`, `label`, `options[]` of
  `{type: "option", id, text}`, selected `input_values` returned as an
  array of option ids) — confirmed via the inbox tutorial's own worked
  example (`departmentChoice: ["sales"]`).
- **List / item components** (`type: "list"`, `items[]` of
  `{type: "item", id, title, subtitle, action}`, action can be a Submit,
  URL, or Sheets action) —
  `docs/references/canvas-kit/interactivecomponents/list`.
- **Button/item action types** `submit`, `url` (`{type: "url", url}`),
  `sheet` — `docs/references/canvas-kit/actioncomponents/url-action` and
  related action-component reference pages.
- **`X-Body-Signature` HMAC-SHA256 request verification** —
  `developers.intercom.com/docs/canvas-kit` plus corroborating community
  threads on the exact hex/raw-body mechanics (cited in SUBMIT.md).
- **`textarea` component** — confirmed to exist as a Canvas Kit component
  type (listed alongside input/checkbox/etc. in the Canvas Kit intro), but
  its own dedicated reference page wasn't independently fetched — its field
  shape here (`id`/`label`/`placeholder`/`value`) is inferred from Input's
  confirmed shape, flagged as the one inferred-not-fetched component in
  SUBMIT.md.

## Anakin API ground truth: two source files, and where live testing corrected both

The original three endpoints (url-scraper, search, agentic-search) were read
from `anakin-py/src/anakin/client.py` / `models.py`. The six endpoints added
in this change (map, crawl, wire_discover, wire_catalog, wire_read_action,
monitor_list, monitor_changes) were read from a different first-party
source instead — `anakin-mcp/src/client.ts` and `anakin-mcp/src/tools/
{wire,monitor}.ts` in this same repo — since that's the ground truth this
task was scoped against. Both are real clients of the same
`api.anakin.io/v1`, so this is still "read from source, not guessed," just a
different source file than the original three endpoints cite.

That source only gets you so far, though: several of its own type
declarations are honestly loose (`WireResolveResponse.results:
Array<Record<string, unknown>>`, `wireCatalog(): Promise<unknown>`) because
the MCP client passes those payloads straight through to a model without
needing to parse specific fields itself. This app *does* need to parse
specific fields (to render list titles, build a params form, filter to read
actions), so those endpoints were also live-curled directly against
`api.anakin.io/v1` with a throwaway key during this change, and two real
discrepancies from what the source's comments/tool descriptions implied were
found and fixed as a result:

1. **`GET /wire/catalog` wraps its array as `{ catalog: [...] }`** (singular
   key) — the initial implementation guessed `catalogs`/`results`/`items`
   and silently rendered "No catalogs returned" against the real API. Fixed
   by adding `catalog` to the extraction key list (kept the guessed keys too,
   as fallbacks). `GET /wire/catalog/:slug`'s `{ actions: [...] }` key,
   by contrast, was guessed correctly the first time.
2. **`GET /wire/resolve` results don't reliably carry Wire's `type`
   (read/write) field** — see "Scope: Wire read actions only" above for the
   full explanation and the design change this drove (grouping resolve
   matches by catalog and always confirming type against `/wire/catalog/
   :slug` before rendering anything as runnable).

A third, Canvas-Kit-adjacent bug was also found this way: `anakinRequest()`'s
error-body parsing (originally written only against the flat
`{error: "msg"}` shape used by url-scraper/search/agentic-search) produced
`"[object Object]"` in the rendered error canvas against Wire's nested
`{error: {code, message}}` envelope — confirmed live via `wire_run_submit`
against a fake API key. Fixed in `server.js`'s `anakinRequest()`, and
along the way, a second flat-shape issue in the *same* function was also
caught live: a bad key against `/v1/crawl` real-returns
`{"error":"unauthorized","message":"Invalid or inactive API key"}` — the
original message-selection logic would have shown the terser `"unauthorized"`
instead of the more useful `"Invalid or inactive API key"`. Both are
covered by regression tests in `test/smoke.test.js` (search for
"regression" in that file).

## Precedent

Zendesk's Yext "AI Search" precedent (see `../zendesk-anakin/README.md`)
confirmed the app *category* — third-party-API-backed search in a support
platform's ticket/conversation sidebar — is an accepted, non-novel shape.
Nothing Intercom-specific was found or needed as separate precedent beyond
Intercom's own tutorial demonstrating this exact sidebar-form-plus-webhook
pattern as the documented, intended way to build Inbox apps.

## Steps (needs the account owner)

1. Create an app in a real Intercom workspace's Developer Hub
   (`Your apps > New app`) — needs a real Intercom account, which this
   session doesn't have.
2. Deploy `server.js` somewhere with a public HTTPS URL (any Node host), set
   `ANAKIN_API_KEY` (from [anakin.io/dashboard](https://anakin.io/dashboard)
   — 300 credits, no card required) and `INTERCOM_CLIENT_SECRET` (from the
   app's Developer Hub > Configure > Authentication page) as env vars.
3. In Developer Hub > Configure > Canvas Kit > For teammates, check "Add to
   conversation details" and paste in the two webhook URLs (see
   `intercom-app-config.json`).
4. Open a real conversation in the Inbox, pin the app to the sidebar, and
   exercise all seven actions (Scrape, AI Search, Agentic Search, Crawl,
   Map, Find & Run a Site Action, Website Monitors) against live data.
5. For a public App Store listing: complete the Developer Hub's submission
   review flow (icon, description, screenshots) — a manual review process,
   not something scriptable from this repo.
