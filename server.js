"use strict";

/**
 * intercom-anakin — Canvas Kit webhook server.
 *
 * Intercom Inbox apps are NOT client-side iframe apps (unlike Zendesk's ZAF
 * apps in ../zendesk-anakin). A Canvas Kit app is a JSON UI description that
 * YOUR server returns in response to POST requests Intercom's own servers
 * send to webhook URLs you register in the Developer Hub — confirmed by
 * fetching developers.intercom.com/docs/canvas-kit.md ("Canvas Kit enables
 * developers to build applications that operate directly within the
 * Intercom interface... You respond with JSON containing canvas.content")
 * and the "Building an Inbox App with Canvas Kit" tutorial
 * (developers.intercom.com/docs/build-an-integration/getting-started/
 * build-an-app-for-your-inbox.md), whose /initialize and /submit Express
 * handlers this file's routing pattern (component_id-based dispatch,
 * request.body.input_values) mirrors directly. There is no client-side
 * JS/HTML asset anywhere in this app — everything the teammate sees is a
 * component tree this server returns.
 *
 * Two webhooks are registered in the Developer Hub (Configure > Canvas Kit
 * > For teammates > "Add to conversation details"):
 *   Initialize flow webhook URL  -> POST /canvas/initialize
 *   Submit flow webhook URL      -> POST /canvas/submit
 * See intercom-app-config.json in this directory for the full set of
 * Developer Hub dashboard values — that file is a reference for what to
 * paste into the dashboard's form fields, NOT a manifest Intercom reads
 * from this repo. Confirmed there is no manifest-file/CLI mechanism for
 * Intercom apps analogous to Zendesk's zcli + manifest.json: web-searched
 * for one directly and found none; the Developer Hub's own "Build an Inbox
 * App" tutorial has the teammate paste webhook URLs into dashboard form
 * fields by hand, and the "tools dashboard" changelog entry confirms the
 * Developer Hub is a web UI, not a file-based app definition.
 *
 * Every request to /canvas/* is verified with the X-Body-Signature header
 * (HMAC-SHA256 of the raw request body using the app's Developer Hub OAuth
 * client secret) per developers.intercom.com/docs/canvas-kit
 * ("Each request includes an X-Body-Signature header using HMAC-SHA256 for
 * verification against your OAuth client secret") — see verifySignature().
 *
 * Anakin's API key (X-API-Key header, https://api.anakin.io/v1) lives only
 * in this server's environment (ANAKIN_API_KEY) — it never reaches
 * Intercom or the teammate's browser, since Canvas Kit has no client-side
 * code at all to leak it from.
 */

const crypto = require("crypto");
const express = require("express");

const PORT = process.env.PORT || 3000;
const ANAKIN_BASE_URL = process.env.ANAKIN_BASE_URL || "https://api.anakin.io/v1";
const ANAKIN_API_KEY = process.env.ANAKIN_API_KEY;
const INTERCOM_CLIENT_SECRET = process.env.INTERCOM_CLIENT_SECRET;

if (!ANAKIN_API_KEY) {
  // Not fatal at boot — lets `node --check` / local smoke tests run without
  // secrets — but every Anakin call below will fail loudly and specifically
  // rather than silently, so this is easy to diagnose in production logs.
  console.warn(
    "[intercom-anakin] ANAKIN_API_KEY is not set. Anakin API calls will fail until it is."
  );
}
if (!INTERCOM_CLIENT_SECRET) {
  console.warn(
    "[intercom-anakin] INTERCOM_CLIENT_SECRET is not set — X-Body-Signature " +
      "verification is DISABLED. Fine for local testing, unsafe in production: " +
      "set it before pointing a real Intercom Developer Hub app at this server."
  );
}

const app = express();

// Capture the raw body alongside the parsed one — signature verification
// (see verifySignature) must HMAC the exact bytes Intercom sent, not a
// re-serialized version of req.body, since JSON.stringify key ordering /
// whitespace differences would break the comparison.
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── Anakin API client (server-side only) ──────────────────────────────────
//
// Ground truth for base URL, auth header, endpoints, and request/response
// shapes: read directly from anakin-py/src/anakin/client.py and
// anakin-py/src/anakin/models.py in this repo, not assumed. Uses Node's
// built-in fetch (global since Node 18) — no extra HTTP dependency.

class AnakinApiError extends Error {
  constructor(message, { status, body, code, details } = {}) {
    super(message);
    this.name = "AnakinApiError";
    this.status = status;
    this.body = body;
    this.code = code;
    this.details = details;
  }
}

// Append a query string, dropping undefined/empty values — mirrors
// anakin-mcp/src/client.ts's withQuery(), used by /wire/resolve and /sessions.
function withQuery(path, params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return path;
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${path}?${qs}`;
}

async function anakinRequest(path, method, body) {
  if (!ANAKIN_API_KEY) {
    throw new AnakinApiError("Server is missing ANAKIN_API_KEY.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${ANAKIN_BASE_URL}${path}`, {
      method,
      headers: {
        "X-API-Key": ANAKIN_API_KEY,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await res.text();
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = { raw };
    }
    if (!res.ok) {
      // Two error envelopes exist on api.anakin.io/v1, confirmed by reading
      // anakin-mcp/src/client.ts's toError(): the legacy flat shape used by
      // url-scraper/search/agentic-search ({ error: "msg", code: "CODE" })
      // and Wire's nested envelope ({ error: { code, message, ... } }, used
      // by /wire/task, /wire/resolve, /wire/catalog). The original version of
      // this function only handled the flat shape — `parsed.message ||
      // parsed.error` would resolve to the *object* on a Wire error and
      // stringify to "[object Object]" in the rendered error canvas. Found by
      // curl-testing the Wire routes added in this change (see SUBMIT.md) and
      // fixed here; test/smoke.test.js has a regression test.
      const errField = parsed && parsed.error;
      let message;
      let code;
      let details;
      if (errField && typeof errField === "object") {
        message = errField.message || errField.code || `Anakin API error ${res.status}`;
        code = errField.code;
        details = errField;
      } else if (typeof errField === "string") {
        // The flat shape's own `error` string (e.g. "unauthorized") is often
        // a terse code; when a sibling `message` field is present it's the
        // human-readable one — confirmed live: a bad key against /v1/crawl
        // returns `{"error":"unauthorized","message":"Invalid or inactive
        // API key"}`. Prefer the descriptive one, falling back to `error`.
        message = (parsed && typeof parsed.message === "string" && parsed.message) || errField;
        code = errField;
      } else {
        message = (parsed && parsed.message) || `Anakin API error ${res.status}`;
      }
      throw new AnakinApiError(message, { status: res.status, body: parsed, code, details });
    }
    return parsed;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new AnakinApiError("Anakin API request timed out after 15s.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function requireJobId(submitted) {
  const jobId = submitted.jobId || submitted.job_id || submitted.id;
  if (!jobId || typeof jobId !== "string") {
    throw new AnakinApiError(
      `Anakin API response did not include a job id: ${JSON.stringify(submitted)}`
    );
  }
  return jobId;
}

// POST /v1/url-scraper, poll GET /v1/url-scraper/:jobId — see client.py `scrape()`.
async function startScrape({ url, country, useBrowser, generateJson, forceFresh }) {
  const submitted = await anakinRequest("/url-scraper", "POST", {
    url,
    country: country || "us",
    useBrowser: !!useBrowser,
    generateJson: !!generateJson,
    forceFresh: !!forceFresh,
  });
  return requireJobId(submitted);
}
function pollScrape(jobId) {
  return anakinRequest(`/url-scraper/${jobId}`, "GET");
}

// POST /v1/search — synchronous, no polling. See client.py `search()`.
function runSearch({ prompt, limit }) {
  return anakinRequest("/search", "POST", { prompt, limit: limit || 5 });
}

// POST /v1/agentic-search, poll GET /v1/agentic-search/:jobId. See client.py `agentic_search()`.
async function startAgenticSearch({ prompt, useBrowser, schema }) {
  const body = { prompt, useBrowser: useBrowser !== false };
  if (schema) body.schema = schema;
  const submitted = await anakinRequest("/agentic-search", "POST", body);
  return requireJobId(submitted);
}
function pollAgenticSearch(jobId) {
  return anakinRequest(`/agentic-search/${jobId}`, "GET");
}

// ─── Additional Anakin API client functions ────────────────────────────────
//
// Ground truth for these five (map, crawl, wire_discover/catalog/read_action,
// monitor_list/changes) is DIFFERENT from the three functions above: read
// directly from anakin-mcp/src/client.ts (this repo's own TypeScript MCP
// client) and anakin-mcp/src/tools/{wire,monitor}.ts — not anakin-py, and not
// re-derived from the Zendesk submission's version of these claims. Both
// anakin-py and anakin-mcp are first-party clients of the same
// api.anakin.io/v1 API, so this is still ground truth, just a different
// source file than the original three endpoints cite.

// POST /v1/map, poll GET /v1/map/:jobId — see client.ts `map()`.
async function startMap({ url, limit, depth, limitPerLevel, includeSubdomains, includeExternalLinks, useBrowser, search }) {
  const body = {
    url,
    limit: limit || 100,
    depth: depth || 2,
    limitPerLevel: limitPerLevel || 100,
    includeSubdomains: !!includeSubdomains,
    includeExternalLinks: !!includeExternalLinks,
    useBrowser: !!useBrowser,
  };
  if (search) body.search = search;
  const submitted = await anakinRequest("/map", "POST", body);
  return requireJobId(submitted);
}
function pollMap(jobId) {
  return anakinRequest(`/map/${jobId}`, "GET");
}

// POST /v1/crawl, poll GET /v1/crawl/:jobId — see client.ts `crawl()`.
async function startCrawl({ url, maxPages, depth, country, useBrowser, includePatterns, excludePatterns }) {
  const body = {
    url,
    maxPages: maxPages || 10,
    depth: depth || 1,
    country: country || "us",
    useBrowser: !!useBrowser,
  };
  if (includePatterns && includePatterns.length) body.includePatterns = includePatterns;
  if (excludePatterns && excludePatterns.length) body.excludePatterns = excludePatterns;
  const submitted = await anakinRequest("/crawl", "POST", body);
  return requireJobId(submitted);
}
function pollCrawl(jobId) {
  return anakinRequest(`/crawl/${jobId}`, "GET");
}

// GET /v1/wire/resolve?q=&limit= — synchronous, no polling. See client.ts `wireResolve()`.
function wireDiscover(q, limit) {
  return anakinRequest(withQuery("/wire/resolve", { q, limit }), "GET");
}

// GET /v1/wire/catalog or /v1/wire/catalog/:slug — synchronous. See client.ts `wireCatalog()`.
function wireCatalog(slug) {
  const path = slug ? `/wire/catalog/${encodeURIComponent(slug)}` : "/wire/catalog";
  return anakinRequest(path, "GET");
}

// POST /v1/wire/task — may return inline data (sync action, no job_id) or
// { job_id } to poll at GET /v1/wire/jobs/:jobId. See client.ts `wireRun()` /
// `pollWireJob()`. This app only ever calls read (data-extraction) Wire
// actions — see "Scope: Wire read actions only" in README.md — so no
// credential_id/identity_id is ever sent; auth-required actions surface as a
// clean AUTH_REQUIRED error with a connect_url the teammate can open.
function wireSubmitTask({ actionId, params }) {
  const body = { action_id: actionId };
  if (params && Object.keys(params).length > 0) body.params = params;
  return anakinRequest("/wire/task", "POST", body);
}
function pollWireJob(jobId) {
  return anakinRequest(`/wire/jobs/${jobId}`, "GET");
}

// GET /v1/monitors, GET /v1/monitors/:id/changes — synchronous, no polling
// (monitors are pre-computed background jobs, not something this app starts).
// See client.ts `monitorList()` / `monitorChanges()`.
function monitorList() {
  return anakinRequest("/monitors", "GET");
}
function monitorChanges(id) {
  return anakinRequest(`/monitors/${encodeURIComponent(id)}/changes`, "GET");
}

// ─── Canvas Kit component builders ──────────────────────────────────────────
//
// Field shapes below were each confirmed against a real, live Intercom
// Canvas Kit reference page (fetched directly, not reconstructed from
// memory) — see README.md "Canvas Kit structure confirmed from source" for
// the citation for every component type used here. `textarea` is the one
// exception: confirmed to exist as a component type (canvas-kit.md lists it
// alongside input/checkbox/etc.) but its own dedicated reference page was
// not independently fetched, so its field shape here is inferred from the
// Input component's confirmed shape (id/label/placeholder/value) — flagged
// in SUBMIT.md.

function text(id, value, { style, align } = {}) {
  const c = { type: "text", id, text: value };
  if (style) c.style = style; // header | paragraph (default) | muted | error
  if (align) c.align = align; // left (default) | center | right
  return c;
}

function button(id, label, { style = "primary", action = { type: "submit" }, disabled = false } = {}) {
  return { type: "button", id, label, style, action, disabled };
}

function input(id, { label, placeholder, value = "" } = {}) {
  const c = { type: "input", id, value };
  if (label) c.label = label;
  if (placeholder) c.placeholder = placeholder;
  return c;
}

function textarea(id, { label, placeholder, value = "" } = {}) {
  const c = { type: "textarea", id, value };
  if (label) c.label = label;
  if (placeholder) c.placeholder = placeholder;
  return c;
}

function checkbox(id, label, options) {
  return { type: "checkbox", id, label: label || "", options };
}

function list(id, items) {
  return { type: "list", id, items };
}

function divider(id) {
  return { type: "divider", id };
}

// canvas.content.components, with optional canvas.stored_data — the
// documented mechanism (developers.intercom.com/docs/references/canvas-kit/
// responseobjects/canvas) for persisting state (job ids, in-flight prompts)
// across the stateless request/response cycle: whatever is returned here
// comes back verbatim as `current_canvas.stored_data` on the *next* request.
function canvas(components, storedData) {
  const out = { canvas: { content: { components } } };
  if (storedData) out.canvas.stored_data = storedData;
  return out;
}

function errorCanvas(message, { retryId, retryLabel = "Try again" } = {}) {
  const components = [
    text("error_heading", "Something went wrong", { style: "header" }),
    text("error_message", String(message), { style: "error" }),
  ];
  if (retryId) components.push(button(retryId, retryLabel, { style: "secondary" }));
  components.push(button("go_home", "Back to Anakin", { style: "link" }));
  return canvas(components);
}

// ─── Screens ────────────────────────────────────────────────────────────────

function homeScreen() {
  return canvas([
    text("heading", "Anakin", { style: "header" }),
    text(
      "subheading",
      "Scrape, crawl, or map a URL; run AI search or agentic research; look up live data on hundreds of sites with Wire; or check a website monitor for this conversation. Copy the result into your reply."
    ),
    list("actions", [
      {
        type: "item",
        id: "pick_scrape",
        title: "Scrape a URL",
        subtitle: "Fetch a page as clean markdown",
        action: { type: "submit" },
      },
      {
        type: "item",
        id: "pick_search",
        title: "AI Search",
        subtitle: "Synchronous web search — 3 credits",
        action: { type: "submit" },
      },
      {
        type: "item",
        id: "pick_agentic",
        title: "Agentic Search",
        subtitle: "Multi-stage AI research — 10 credits",
        action: { type: "submit" },
      },
      {
        type: "item",
        id: "pick_crawl",
        title: "Crawl a Site",
        subtitle: "Bulk-fetch markdown across many pages",
        action: { type: "submit" },
      },
      {
        type: "item",
        id: "pick_map",
        title: "Map a Site",
        subtitle: "List a domain's discoverable URLs",
        action: { type: "submit" },
      },
      {
        type: "item",
        id: "pick_wire",
        title: "Find & Run a Site Action",
        subtitle: "Look up live data (orders, listings, profiles) on a specific site",
        action: { type: "submit" },
      },
      {
        type: "item",
        id: "pick_monitors",
        title: "Website Monitors",
        subtitle: "Check what changed on a watched page",
        action: { type: "submit" },
      },
    ]),
  ]);
}

function scrapeFormScreen() {
  return canvas([
    text("scrape_heading", "Scrape a URL", { style: "header" }),
    input("scrape_url", { label: "URL", placeholder: "https://example.com/pricing" }),
    input("scrape_country", { label: "Country code", placeholder: "us", value: "us" }),
    checkbox("scrape_options", "Options", [
      { type: "option", id: "useBrowser", text: "Use browser rendering (JS-heavy pages)" },
      { type: "option", id: "generateJson", text: "Generate structured JSON" },
      { type: "option", id: "forceFresh", text: "Force fresh (skip cache)" },
    ]),
    button("scrape_submit", "Scrape", { style: "primary" }),
    button("go_home", "Back", { style: "link" }),
  ]);
}

function scrapeProcessingScreen(jobId) {
  return canvas(
    [
      text("scrape_processing", "Scraping… this can take a few seconds for JS-rendered pages.", {
        style: "paragraph",
      }),
      button("scrape_poll", "Check status", { style: "primary" }),
      button("go_home", "Cancel", { style: "link" }),
    ],
    { job_type: "url-scraper", job_id: jobId }
  );
}

function scrapeResultScreen(doc) {
  const body = doc.markdown || doc.summary || doc.cleanedHtml || doc.html || "(no content returned)";
  const truncated = body.length > 6000 ? `${body.slice(0, 6000)}\n\n…(truncated)` : body;
  return canvas([
    text("scrape_result_heading", `Scraped ${doc.url || ""}`.trim(), { style: "header" }),
    text("scrape_result_meta", doc.cached ? "Served from cache." : "Freshly fetched.", { style: "muted" }),
    text("scrape_result_body", truncated),
    text("scrape_result_hint", "Select and copy the text above into your reply.", { style: "muted" }),
    button("pick_scrape", "Scrape another URL", { style: "secondary" }),
    button("go_home", "Back", { style: "link" }),
  ]);
}

function searchFormScreen() {
  return canvas([
    text("search_heading", "AI Search", { style: "header" }),
    textarea("search_prompt", {
      label: "Search prompt",
      placeholder: "e.g. latest pricing for Acme Corp's API plan",
    }),
    input("search_limit", { label: "Result limit", value: "5" }),
    button("search_submit", "Search", { style: "primary" }),
    button("go_home", "Back", { style: "link" }),
    text("search_hint", "Synchronous — costs 3 credits per call.", { style: "muted" }),
  ]);
}

function searchResultScreen(result, prompt) {
  const items = result.results || [];
  if (items.length === 0) {
    return canvas([
      text("search_empty", `No results for: ${prompt}`),
      button("pick_search", "New search", { style: "secondary" }),
      button("go_home", "Back", { style: "link" }),
    ]);
  }
  return canvas([
    text("search_result_heading", `${items.length} result(s) for: ${prompt}`, { style: "header" }),
    list(
      "search_results",
      items.map((item, idx) => ({
        type: "item",
        id: `result_${idx}`,
        title: item.title || item.url,
        subtitle: item.snippet ? item.snippet.slice(0, 140) : item.url,
        action: { type: "url", url: item.url },
      }))
    ),
    text("search_hint", "Tap a result to open it; copy details into your reply.", { style: "muted" }),
    button("pick_search", "New search", { style: "secondary" }),
    button("go_home", "Back", { style: "link" }),
  ]);
}

function agenticFormScreen() {
  return canvas([
    text("agentic_heading", "Agentic Search", { style: "header" }),
    textarea("agentic_prompt", {
      label: "Research prompt",
      placeholder: "e.g. summarize Acme Corp's refund policy and cite the source page",
    }),
    textarea("agentic_schema", {
      label: "Structured data schema (optional, JSON Schema)",
      placeholder: '{"type": "object", "properties": {"policy_summary": {"type": "string"}}}',
    }),
    button("agentic_submit", "Run agentic search", { style: "primary" }),
    button("go_home", "Back", { style: "link" }),
    text("agentic_hint", "Multi-stage AI research — costs 10 credits.", { style: "muted" }),
  ]);
}

function agenticProcessingScreen(jobId) {
  return canvas(
    [
      text("agentic_processing", "Researching… agentic search runs multiple stages and can take a while.", {
        style: "paragraph",
      }),
      button("agentic_poll", "Check status", { style: "primary" }),
      button("go_home", "Cancel", { style: "link" }),
    ],
    { job_type: "agentic-search", job_id: jobId }
  );
}

function agenticResultScreen(result) {
  const generated = result.generatedJson || {};
  const summary = generated.summary || "(no summary returned)";
  const components = [
    text("agentic_result_heading", "Research summary", { style: "header" }),
    text("agentic_result_body", summary),
  ];
  if (generated.structuredData || generated.structured_data) {
    const structured = generated.structuredData || generated.structured_data;
    const json = JSON.stringify(structured, null, 2);
    components.push(divider("agentic_result_divider"));
    components.push(text("agentic_result_structured_heading", "Structured data", { style: "header" }));
    components.push(text("agentic_result_structured", json.length > 3000 ? `${json.slice(0, 3000)}\n…(truncated)` : json));
  }
  components.push(text("agentic_result_hint", "Select and copy the text above into your reply.", { style: "muted" }));
  components.push(button("pick_agentic", "New research", { style: "secondary" }));
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components);
}

// ─── Crawl screens ──────────────────────────────────────────────────────────

function crawlFormScreen() {
  return canvas([
    text("crawl_heading", "Crawl a Site", { style: "header" }),
    text(
      "crawl_subheading",
      "Bulk-fetch markdown across many pages of a site at once — useful for pulling a whole docs section into this sidebar.",
      { style: "muted" }
    ),
    input("crawl_url", { label: "URL", placeholder: "https://example.com/docs" }),
    input("crawl_max_pages", { label: "Max pages (up to 500)", value: "10" }),
    input("crawl_depth", { label: "Depth (link-hops)", value: "1" }),
    input("crawl_country", { label: "Country code", value: "us" }),
    input("crawl_include", { label: "Include patterns (comma-separated, optional)", placeholder: "/docs/*" }),
    input("crawl_exclude", { label: "Exclude patterns (comma-separated, optional)", placeholder: "/blog/*" }),
    checkbox("crawl_options", "Options", [
      { type: "option", id: "useBrowser", text: "Use browser rendering (JS-heavy pages)" },
    ]),
    button("crawl_submit", "Crawl", { style: "primary" }),
    button("go_home", "Back", { style: "link" }),
  ]);
}

function crawlProcessingScreen(jobId) {
  return canvas(
    [
      text("crawl_processing", "Crawling… fetching multiple pages can take a while.", { style: "paragraph" }),
      button("crawl_poll", "Check status", { style: "primary" }),
      button("go_home", "Cancel", { style: "link" }),
    ],
    { job_type: "crawl", job_id: jobId }
  );
}

function crawlResultScreen(result) {
  const pages = result.pages || [];
  const shown = pages.slice(0, 25);
  const components = [
    text("crawl_result_heading", `Crawled ${result.url || ""}`.trim(), { style: "header" }),
    text(
      "crawl_result_meta",
      `${result.completedPages ?? shown.length}/${result.totalPages ?? pages.length} page(s) fetched`,
      { style: "muted" }
    ),
  ];
  if (shown.length > 0) {
    components.push(
      list(
        "crawl_result_pages",
        shown.map((p, idx) => ({
          type: "item",
          id: `crawl_page_${idx}`,
          title: p.url || `Page ${idx + 1}`,
          subtitle:
            p.status === "completed"
              ? `${(p.markdown || p.html || "").length} chars fetched`
              : p.error || "failed",
          action: { type: "url", url: p.url },
        }))
      )
    );
  }
  if (pages.length > shown.length) {
    components.push(
      text("crawl_result_truncated", `Showing the first ${shown.length} of ${pages.length} pages.`, {
        style: "muted",
      })
    );
  }
  components.push(
    text("crawl_result_hint", "Tap a page to open it, or Scrape a specific URL for its full markdown here.", {
      style: "muted",
    })
  );
  components.push(button("pick_crawl", "Crawl another site", { style: "secondary" }));
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components);
}

// ─── Map screens ────────────────────────────────────────────────────────────

function mapFormScreen() {
  return canvas([
    text("map_heading", "Map a Site", { style: "header" }),
    text("map_subheading", "List the URLs reachable from a starting page — handy for finding the right page to scrape or crawl.", {
      style: "muted",
    }),
    input("map_url", { label: "URL", placeholder: "https://example.com" }),
    input("map_limit", { label: "Max URLs", value: "100" }),
    input("map_depth", { label: "Depth (link-hops)", value: "2" }),
    checkbox("map_options", "Options", [
      { type: "option", id: "includeSubdomains", text: "Include subdomains" },
      { type: "option", id: "includeExternalLinks", text: "Include external links (not followed)" },
      { type: "option", id: "useBrowser", text: "Use browser rendering (JS-heavy pages)" },
    ]),
    button("map_submit", "Map site", { style: "primary" }),
    button("go_home", "Back", { style: "link" }),
  ]);
}

function mapProcessingScreen(jobId) {
  return canvas(
    [
      text("map_processing", "Mapping site… this can take a few seconds.", { style: "paragraph" }),
      button("map_poll", "Check status", { style: "primary" }),
      button("go_home", "Cancel", { style: "link" }),
    ],
    { job_type: "map", job_id: jobId }
  );
}

function mapResultScreen(result) {
  const links = result.links || [];
  const shown = links.slice(0, 30);
  const components = [
    text("map_result_heading", `Mapped ${result.url || ""}`.trim(), { style: "header" }),
    text(
      "map_result_meta",
      `${result.totalLinks ?? links.length} internal link(s)` +
        (result.totalExternalLinks ? `, ${result.totalExternalLinks} external` : ""),
      { style: "muted" }
    ),
  ];
  if (shown.length > 0) {
    components.push(
      list(
        "map_result_links",
        shown.map((url, idx) => ({ type: "item", id: `map_link_${idx}`, title: url, action: { type: "url", url } }))
      )
    );
  }
  if (links.length > shown.length) {
    components.push(text("map_result_truncated", `Showing the first ${shown.length} of ${links.length} links.`, { style: "muted" }));
  }
  components.push(button("pick_map", "Map another site", { style: "secondary" }));
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components);
}

// ─── Wire screens ───────────────────────────────────────────────────────────
//
// Scope: Wire read actions only. Wire also has WRITE actions (submit a form,
// add to cart) — anakin-mcp/src/tools/wire.ts splits these into two separate
// tools (wire_read_action / wire_write_action) specifically because a write
// action changes state on a third-party site and needs an explicit
// confirmation step the tool-calling model (or a support-agent sidebar
// button tap) provides. This app only ever calls POST /wire/task for actions
// whose `type` is confirmed "read" — and never exposes write actions at all,
// matching the task brief's instruction to skip wire_write_action. It also
// never calls wire_login / wire_identities (no credential management UI
// here), so auth-required actions surface as a clean "connect account"
// prompt instead of running.
//
// IMPORTANT, found by live-curling both endpoints against the real API (not
// assumed from client.ts's `Record<string, unknown>` typing): GET
// /wire/resolve's results do NOT reliably include a `type` field — a live
// query returned three candidates with only {action_id, auth_required,
// auth_satisfied, catalog, credits, params}, no read/write marker at all.
// GET /wire/catalog/:slug's `actions[]`, by contrast, DOES reliably include
// `type: "read" | "write"` (confirmed live for 1800flowers). Trusting a
// missing/absent field on the resolve response as "not read" would either
// silently hide legitimate read actions or (worse) let a write action through
// if the field's absence doesn't actually mean "write" server-side — either
// way, guessing at an unconfirmed safety-relevant field is not acceptable
// here. So this app's ONLY path from "discovered a candidate" to "run it" is:
// resolve → group candidates by their `catalog` slug → fetch that catalog's
// full action list (which reliably reports `type`) → filter to type==="read"
// → run. wire_discover never renders a directly-runnable action; it always
// bounces through the type-confirmed catalog view. See README.md.

// Field names below are the ones confirmed live against api.anakin.io/v1
// (not just client.ts's loose `Record<string, unknown>` / `unknown` typing):
//   GET /wire/catalog        -> { catalog: [{ slug, name, description,
//                                 action_count, auth_required, url, ... }] }
//   GET /wire/catalog/:slug  -> { actions: [{ action_id, name, description,
//                                 type, auth_mode, auth_required,
//                                 credits_per_call, parameters: [{name,
//                                 type, required, default, description}] }] }
//   GET /wire/resolve        -> { results: [{ action_id, catalog, credits,
//                                 auth_required, auth_satisfied, params:
//                                 {required:[...], optional:[...]} }],
//                                 next }
// Still read defensively with fallbacks (the same style used elsewhere in
// this file, e.g. scrapeResultScreen's `doc.markdown || doc.summary || ...`)
// in case a given response omits a field this app doesn't strictly require.
function wireActionTitle(a) {
  return a.name || a.title || a.label || a.action_id || a.id || "Untitled action";
}
function wireActionDescription(a) {
  return a.description || a.summary || "";
}
function wireActionId(a) {
  return a.action_id || a.id;
}
function wireActionType(a) {
  return a.type || a.action_type;
}
function wireActionAuthMode(a) {
  if (a.auth_mode || a.authMode) return a.auth_mode || a.authMode;
  if (typeof a.auth_required === "boolean") return a.auth_required ? "required" : "none";
  return "none";
}
function wireActionCredits(a) {
  return a.credits_per_call ?? a.credits ?? a.credit_cost ?? a.creditCost;
}
// Confirmed shape: an array of { name, type, required, default, description }
// (NOT a JSON Schema {properties: {...}} object, despite client.ts's own
// wire_run tool description saying "params ... use its parameter schema").
function wireActionParameters(a) {
  return Array.isArray(a.parameters) ? a.parameters : [];
}

// Only read actions are ever offered — see the scope note above. Only used
// on catalog-sourced action lists, where `type` is reliably present.
function wireReadCandidates(list) {
  return (Array.isArray(list) ? list : []).filter((a) => a && wireActionType(a) === "read");
}

function wireCatalogEntrySlug(c) {
  return c.slug || c.id || c.name;
}
function wireCatalogEntryTitle(c) {
  return c.name || c.title || c.slug || c.id || "Untitled site";
}
function wireCatalogEntryActionCount(c) {
  return c.action_count ?? c.actionCount ?? (Array.isArray(c.actions) ? c.actions.length : undefined);
}
function extractList(response, keys) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== "object") return [];
  for (const k of keys) {
    if (Array.isArray(response[k])) return response[k];
  }
  return [];
}

function defaultForParamType(t) {
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return false;
  if (t === "array") return [];
  if (t === "object") return {};
  return "";
}

// Best-effort { paramName: default-or-empty } skeleton from a catalog
// action's `parameters` array, so the params textarea starts with something
// editable instead of blank — purely a UX nicety, never assumed complete.
function paramsSkeleton(parameters) {
  const out = {};
  for (const p of parameters) {
    if (!p || !p.name) continue;
    out[p.name] = p.default !== undefined ? p.default : defaultForParamType(p.type);
  }
  return out;
}

// Short "name: type (required)" summary line for the run form, so the
// teammate can see what's expected without leaving the sidebar.
function paramsSummary(parameters) {
  if (parameters.length === 0) return "This action takes no parameters.";
  return parameters
    .map((p) => `${p.name}: ${p.type || "any"}${p.required ? "" : " (optional)"}`)
    .join(", ");
}

function wireDiscoverFormScreen() {
  return canvas([
    text("wire_heading", "Find & Run a Site Action", { style: "header" }),
    text(
      "wire_subheading",
      "Wire is Anakin's catalog of pre-built actions across hundreds of sites — look up an order, a listing, a profile, or dashboard data without writing a scraper. This app only runs read (data-lookup) actions; actions that change something on the target site are never shown as runnable here.",
      { style: "muted" }
    ),
    textarea("wire_query", {
      label: "What do you need to look up?",
      placeholder: "e.g. check tracking status on shipstation, get a product's price on walmart",
    }),
    button("wire_discover_submit", "Find actions", { style: "primary" }),
    button("pick_wire_catalog", "Browse the catalog instead", { style: "secondary" }),
    button("go_home", "Back", { style: "link" }),
  ]);
}

// candidates here are always catalog-sourced (`actions[]` from GET
// /wire/catalog/:slug) and already type-filtered to "read" by the caller —
// see the scope note above for why resolve results never reach this screen
// directly.
function wireCandidatesScreen(heading, subheading, candidates, { excludedCount = 0, backId = "pick_wire", backLabel = "New search" } = {}) {
  const components = [text("wire_results_heading", heading, { style: "header" })];
  if (subheading) components.push(text("wire_results_subheading", subheading, { style: "muted" }));
  if (candidates.length === 0) {
    components.push(text("wire_results_empty", "No read actions found. Try a different site or phrasing.", { style: "muted" }));
  } else {
    components.push(
      list(
        "wire_candidates",
        candidates.map((c, idx) => ({
          type: "item",
          id: `wire_pick_${idx}`,
          title: wireActionTitle(c),
          subtitle:
            wireActionDescription(c).slice(0, 120) ||
            `auth: ${wireActionAuthMode(c)}${wireActionCredits(c) !== undefined ? ` · ${wireActionCredits(c)} credits` : ""}`,
          action: { type: "submit" },
        }))
      )
    );
  }
  if (excludedCount > 0) {
    components.push(
      text(
        "wire_results_filtered",
        `${excludedCount} write action(s) omitted — this app only runs read (data-lookup) actions.`,
        { style: "muted" }
      )
    );
  }
  components.push(button(backId, backLabel, { style: "secondary" }));
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components, {
    wire_candidates: candidates.map((c) => ({
      action_id: wireActionId(c),
      title: wireActionTitle(c),
      description: wireActionDescription(c),
      auth_mode: wireActionAuthMode(c),
      credits: wireActionCredits(c),
      parameters: wireActionParameters(c),
    })),
  });
}

// Intermediate disambiguation step for wire_discover_submit when a query
// matches actions across more than one site — reuses the exact same
// wire_catalog_pick_{idx} dispatch and stored_data.wire_catalogs shape as
// the "Browse the catalog" entry point (see the prefix-dispatch block in
// /canvas/submit), so there is exactly one code path from "picked a site" to
// "type-confirmed read actions for that site."
function wireSitesScreen(query, sites) {
  const components = [
    text("wire_sites_heading", `${sites.length} site(s) matched: ${query}`, { style: "header" }),
    text(
      "wire_sites_subheading",
      "Pick a site to see its confirmed read actions (Wire's search results don't reliably mark read vs. write, so this app always confirms against that site's full catalog entry first).",
      { style: "muted" }
    ),
  ];
  components.push(
    list(
      "wire_sites",
      sites.map((s, idx) => ({
        type: "item",
        id: `wire_catalog_pick_${idx}`,
        title: s.slug,
        subtitle: `${s.matchCount} matching result(s) in this search`,
        action: { type: "submit" },
      }))
    )
  );
  components.push(button("pick_wire", "New search", { style: "secondary" }));
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components, { wire_catalogs: sites.map((s) => ({ slug: s.slug, title: s.slug })) });
}

function wireCatalogListScreen(catalogs) {
  const components = [
    text("wire_catalog_heading", "Browse the Wire Catalog", { style: "header" }),
    text("wire_catalog_subheading", "Pick a site to see its available read actions.", { style: "muted" }),
  ];
  if (catalogs.length === 0) {
    components.push(text("wire_catalog_empty", "No catalogs returned.", { style: "muted" }));
  } else {
    components.push(
      list(
        "wire_catalogs",
        catalogs.map((c, idx) => ({
          type: "item",
          id: `wire_catalog_pick_${idx}`,
          title: c.title,
          subtitle: c.actionCount !== undefined ? `${c.actionCount} action(s)` : "",
          action: { type: "submit" },
        }))
      )
    );
  }
  components.push(button("pick_wire", "Back to search", { style: "secondary" }));
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components, { wire_catalogs: catalogs.slice(0, 50) });
}

function wireActionRunFormScreen(candidate) {
  const components = [
    text("wire_run_heading", candidate.title, { style: "header" }),
  ];
  const metaParts = [];
  if (candidate.description) metaParts.push(candidate.description);
  metaParts.push(`auth: ${candidate.auth_mode || "none"}`);
  if (candidate.credits !== undefined) metaParts.push(`${candidate.credits} credits`);
  components.push(text("wire_run_meta", metaParts.join(" · "), { style: "muted" }));
  if (candidate.auth_mode && candidate.auth_mode !== "none") {
    components.push(
      text(
        "wire_run_auth_hint",
        "This action needs an authenticated account. If it isn't already connected, running it will return a link to connect one.",
        { style: "muted" }
      )
    );
  }
  const parameters = candidate.parameters || [];
  components.push(text("wire_run_params_summary", paramsSummary(parameters), { style: "muted" }));
  const skeleton = paramsSkeleton(parameters);
  components.push(
    textarea("wire_params", {
      label: "Parameters (JSON, optional — leave {} if the action needs none)",
      value: Object.keys(skeleton).length > 0 ? JSON.stringify(skeleton, null, 2) : "",
      placeholder: "{}",
    })
  );
  components.push(button("wire_run_submit", "Run action", { style: "primary" }));
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components, {
    wire_selected: { action_id: candidate.action_id, title: candidate.title, auth_mode: candidate.auth_mode },
  });
}

function wireActionProcessingScreen(jobId, title) {
  return canvas(
    [
      text("wire_run_processing", `Running "${title}"… this can take a few seconds.`, { style: "paragraph" }),
      button("wire_run_poll", "Check status", { style: "primary" }),
      button("go_home", "Cancel", { style: "link" }),
    ],
    { job_type: "wire", job_id: jobId, action_title: title }
  );
}

function wireActionResultScreen(data, title) {
  const json = JSON.stringify(data ?? {}, null, 2);
  const truncated = json.length > 4000 ? `${json.slice(0, 4000)}\n\n…(truncated)` : json;
  return canvas([
    text("wire_result_heading", `Result: ${title}`, { style: "header" }),
    text("wire_result_body", truncated),
    text("wire_result_hint", "Select and copy the text above into your reply.", { style: "muted" }),
    button("pick_wire", "New search", { style: "secondary" }),
    button("go_home", "Back", { style: "link" }),
  ]);
}

// Dedicated failure screen (rather than reusing errorCanvas()) so an
// AUTH_REQUIRED failure — the one Wire failure mode with an actionable next
// step — can surface its connect_url as a real "Connect account" button.
// Confirmed shape from client.ts's WireJobError: `{ code, message,
// connect_url? }`, present on both a synchronous POST /wire/task rejection
// and a polled job's terminal `error` field.
function wireFailureCanvas(err, { retryId } = {}) {
  const message = (err && (err.message || err.code)) || "Wire action failed.";
  const components = [
    text("wire_error_heading", "Action failed", { style: "header" }),
    text("wire_error_message", String(message), { style: "error" }),
  ];
  const connectUrl = err && err.connect_url;
  if (err && err.code === "AUTH_REQUIRED" && connectUrl) {
    components.push(
      text("wire_error_connect_hint", "Connect the required account, then try again.", { style: "muted" })
    );
    components.push(
      button("wire_connect_url", "Connect account", { style: "secondary", action: { type: "url", url: connectUrl } })
    );
  }
  if (retryId) components.push(button(retryId, "Try again", { style: "secondary" }));
  components.push(button("go_home", "Back to Anakin", { style: "link" }));
  return canvas(components);
}

// ─── Monitor screens ────────────────────────────────────────────────────────
//
// anakin-mcp/src/tools/monitor.ts's redactSecrets() strips `alertWebhookSecret`
// from every monitor before it reaches a model, because that field is an HMAC
// signing secret and "a secret that enters the chat transcript is compromised
// by definition." This app has no equivalent redaction helper because it
// doesn't need one: monitorListScreen/monitorChangesScreen below only ever
// read specific known-safe fields (id, url, isActive, intervalMinutes,
// detectedAt, summary) off the response and never JSON.stringify the raw
// monitor object the way wireActionResultScreen does for Wire's `data` field
// — so a secret field, if present, is never rendered or stored regardless of
// what else the API response contains.

function monitorListScreen(monitors) {
  const shown = monitors.slice(0, 20);
  const components = [text("monitor_list_heading", "Website Monitors", { style: "header" })];
  if (shown.length === 0) {
    components.push(
      text(
        "monitor_list_empty",
        "No monitors configured yet. Monitors are created from the Anakin dashboard or API, not from this sidebar.",
        { style: "muted" }
      )
    );
  } else {
    components.push(
      list(
        "monitor_list",
        shown.map((m, idx) => ({
          type: "item",
          id: `monitor_pick_${idx}`,
          title: m.url || m.id || `Monitor ${idx + 1}`,
          subtitle:
            `${m.isActive === false ? "paused" : "active"}` +
            (m.intervalMinutes ? ` · every ${m.intervalMinutes} min` : ""),
          action: { type: "submit" },
        }))
      )
    );
    if (monitors.length > shown.length) {
      components.push(text("monitor_list_truncated", `Showing the first ${shown.length} of ${monitors.length} monitors.`, { style: "muted" }));
    }
  }
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components, { monitors: shown.map((m) => ({ id: m.id, url: m.url })) });
}

function monitorChangesScreen(ref, changes) {
  const shown = changes.slice(0, 15);
  const components = [
    text("monitor_changes_heading", `Changes: ${ref.url || ref.id}`, { style: "header" }),
  ];
  if (shown.length === 0) {
    components.push(text("monitor_changes_empty", "No changes detected yet.", { style: "muted" }));
  } else {
    shown.forEach((c, idx) => {
      const when = c.detectedAt || c.createdAt || c.timestamp || `Change ${idx + 1}`;
      const summary = (c.summary || c.description || c.diff || "").toString().slice(0, 300);
      components.push(text(`monitor_change_${idx}`, `${when}${summary ? ` — ${summary}` : ""}`));
    });
    if (changes.length > shown.length) {
      components.push(text("monitor_changes_truncated", `Showing the ${shown.length} most recent of ${changes.length} changes.`, { style: "muted" }));
    }
  }
  components.push(button("pick_monitors", "Back to monitors", { style: "secondary" }));
  components.push(button("go_home", "Back", { style: "link" }));
  return canvas(components);
}

// ─── Signature verification ─────────────────────────────────────────────────
//
// developers.intercom.com/docs/canvas-kit: "Each request includes an
// X-Body-Signature header using HMAC-SHA256 for verification against your
// OAuth client secret." Community-confirmed mechanics (webhook signature
// threads referenced in README.md): hex-encoded HMAC-SHA256 of the raw
// request body, compared byte-for-byte against the header value.

function verifySignature(req) {
  // Read from process.env at call time (not a module-level const captured at
  // require()) so a secret configured/rotated after boot — or set per-test —
  // takes effect without re-requiring the module.
  const secret = process.env.INTERCOM_CLIENT_SECRET;
  if (!secret) {
    return { ok: true, skipped: true };
  }
  const signature = req.get("X-Body-Signature");
  if (!signature || !req.rawBody) {
    return { ok: false, skipped: false };
  }
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) {
    return { ok: false, skipped: false };
  }
  return { ok: crypto.timingSafeEqual(a, b), skipped: false };
}

function requireValidSignature(req, res, next) {
  const result = verifySignature(req);
  if (!result.ok) {
    console.warn("[intercom-anakin] rejected request with invalid X-Body-Signature");
    return res.status(401).json({ error: "invalid signature" });
  }
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, anakinConfigured: !!ANAKIN_API_KEY });
});

// POST from Intercom when a teammate opens/loads the app in the conversation
// details sidebar. Confirmed shape: developers.intercom.com/docs/
// build-an-integration/getting-started/build-an-app-for-your-inbox.md
// ("When Intercom displays your app, it POSTs to /initialize").
app.post("/canvas/initialize", requireValidSignature, (req, res) => {
  const conversationId = req.body && req.body.conversation && req.body.conversation.id;
  if (conversationId) {
    console.log(`[intercom-anakin] initialize for conversation ${conversationId}`);
  }
  res.json(homeScreen());
});

// POST from Intercom whenever a teammate clicks a component with a submit
// action. `component_id` says which one; `input_values` carries whatever
// the teammate typed/checked; `current_canvas.stored_data` carries whatever
// this server returned as stored_data on the previous round trip. All three
// field names confirmed against the Canvas Kit request-object docs (see
// README.md citations) and match the tutorial's request.body shape exactly.
app.post("/canvas/submit", requireValidSignature, async (req, res) => {
  const { component_id: componentId, input_values: inputValues = {} } = req.body || {};
  const storedData = (req.body && req.body.current_canvas && req.body.current_canvas.stored_data) || {};

  try {
    // Dynamic, index-based component_ids (one per list item rendered from a
    // server-generated results list) can't be `switch` cases — dispatched
    // here by prefix before the static switch below. Mirrors the switch's
    // own "look up by id, fail back to a recoverable error canvas if the
    // referenced stored_data entry is gone" pattern (see scrape_poll).
    if (typeof componentId === "string" && componentId.startsWith("wire_pick_")) {
      const idx = parseInt(componentId.slice("wire_pick_".length), 10);
      const candidate = (storedData.wire_candidates || [])[idx];
      if (!candidate || !candidate.action_id) {
        return res.json(errorCanvas("Lost track of that action. Search again.", { retryId: "pick_wire" }));
      }
      return res.json(wireActionRunFormScreen(candidate));
    }

    if (typeof componentId === "string" && componentId.startsWith("wire_catalog_pick_")) {
      const idx = parseInt(componentId.slice("wire_catalog_pick_".length), 10);
      const ref = (storedData.wire_catalogs || [])[idx];
      if (!ref || !ref.slug) {
        return res.json(errorCanvas("Lost track of that catalog. Browse again.", { retryId: "pick_wire_catalog" }));
      }
      const catalogResponse = await wireCatalog(ref.slug);
      const actions = extractList(catalogResponse, ["actions", "results", "items"]);
      const readActions = wireReadCandidates(actions);
      return res.json(
        wireCandidatesScreen(`${ref.title || ref.slug} — read actions`, undefined, readActions, {
          excludedCount: actions.length - readActions.length,
          backId: "pick_wire_catalog",
          backLabel: "Back to catalog",
        })
      );
    }

    if (typeof componentId === "string" && componentId.startsWith("monitor_pick_")) {
      const idx = parseInt(componentId.slice("monitor_pick_".length), 10);
      const ref = (storedData.monitors || [])[idx];
      if (!ref || !ref.id) {
        return res.json(errorCanvas("Lost track of that monitor. Go back to the list.", { retryId: "pick_monitors" }));
      }
      const changesResponse = await monitorChanges(ref.id);
      const changes = extractList(changesResponse, ["changes", "results", "items"]);
      return res.json(monitorChangesScreen(ref, changes));
    }

    switch (componentId) {
      case "go_home":
        return res.json(homeScreen());

      case "pick_scrape":
        return res.json(scrapeFormScreen());

      case "scrape_submit": {
        const url = (inputValues.scrape_url || "").trim();
        if (!url) {
          return res.json(errorCanvas("Enter a URL to scrape.", { retryId: "pick_scrape", retryLabel: "Back to form" }));
        }
        const selectedOptions = inputValues.scrape_options || [];
        const jobId = await startScrape({
          url,
          country: (inputValues.scrape_country || "us").trim(),
          useBrowser: selectedOptions.includes("useBrowser"),
          generateJson: selectedOptions.includes("generateJson"),
          forceFresh: selectedOptions.includes("forceFresh"),
        });
        return res.json(scrapeProcessingScreen(jobId));
      }

      case "scrape_poll": {
        if (!storedData.job_id) {
          return res.json(errorCanvas("Lost track of the scrape job. Start again.", { retryId: "pick_scrape" }));
        }
        const doc = await pollScrape(storedData.job_id);
        if (doc.status === "completed") {
          return res.json(scrapeResultScreen(doc));
        }
        if (doc.status === "failed") {
          return res.json(errorCanvas(doc.error || "Scrape job failed.", { retryId: "pick_scrape" }));
        }
        return res.json(scrapeProcessingScreen(storedData.job_id));
      }

      case "pick_search":
        return res.json(searchFormScreen());

      case "search_submit": {
        const prompt = (inputValues.search_prompt || "").trim();
        if (!prompt) {
          return res.json(errorCanvas("Enter a search prompt.", { retryId: "pick_search", retryLabel: "Back to form" }));
        }
        const limit = parseInt(inputValues.search_limit, 10) || 5;
        const result = await runSearch({ prompt, limit });
        return res.json(searchResultScreen(result, prompt));
      }

      case "pick_agentic":
        return res.json(agenticFormScreen());

      case "agentic_submit": {
        const prompt = (inputValues.agentic_prompt || "").trim();
        if (!prompt) {
          return res.json(errorCanvas("Enter a research prompt.", { retryId: "pick_agentic", retryLabel: "Back to form" }));
        }
        let schema;
        const schemaText = (inputValues.agentic_schema || "").trim();
        if (schemaText) {
          try {
            schema = JSON.parse(schemaText);
          } catch (e) {
            return res.json(
              errorCanvas(`Schema is not valid JSON: ${e.message}`, { retryId: "pick_agentic", retryLabel: "Back to form" })
            );
          }
        }
        const jobId = await startAgenticSearch({ prompt, useBrowser: true, schema });
        return res.json(agenticProcessingScreen(jobId));
      }

      case "agentic_poll": {
        if (!storedData.job_id) {
          return res.json(errorCanvas("Lost track of the research job. Start again.", { retryId: "pick_agentic" }));
        }
        const result = await pollAgenticSearch(storedData.job_id);
        if (result.status === "completed") {
          return res.json(agenticResultScreen(result));
        }
        if (result.status === "failed") {
          return res.json(errorCanvas(result.error || "Agentic search job failed.", { retryId: "pick_agentic" }));
        }
        return res.json(agenticProcessingScreen(storedData.job_id));
      }

      case "pick_crawl":
        return res.json(crawlFormScreen());

      case "crawl_submit": {
        const url = (inputValues.crawl_url || "").trim();
        if (!url) {
          return res.json(errorCanvas("Enter a URL to crawl.", { retryId: "pick_crawl", retryLabel: "Back to form" }));
        }
        const selectedOptions = inputValues.crawl_options || [];
        const includePatterns = (inputValues.crawl_include || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const excludePatterns = (inputValues.crawl_exclude || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const jobId = await startCrawl({
          url,
          maxPages: parseInt(inputValues.crawl_max_pages, 10) || 10,
          depth: parseInt(inputValues.crawl_depth, 10) || 1,
          country: (inputValues.crawl_country || "us").trim(),
          useBrowser: selectedOptions.includes("useBrowser"),
          includePatterns,
          excludePatterns,
        });
        return res.json(crawlProcessingScreen(jobId));
      }

      case "crawl_poll": {
        if (!storedData.job_id) {
          return res.json(errorCanvas("Lost track of the crawl job. Start again.", { retryId: "pick_crawl" }));
        }
        const result = await pollCrawl(storedData.job_id);
        if (result.status === "completed") {
          return res.json(crawlResultScreen(result));
        }
        if (result.status === "failed") {
          return res.json(errorCanvas(result.error || "Crawl job failed.", { retryId: "pick_crawl" }));
        }
        return res.json(crawlProcessingScreen(storedData.job_id));
      }

      case "pick_map":
        return res.json(mapFormScreen());

      case "map_submit": {
        const url = (inputValues.map_url || "").trim();
        if (!url) {
          return res.json(errorCanvas("Enter a URL to map.", { retryId: "pick_map", retryLabel: "Back to form" }));
        }
        const selectedOptions = inputValues.map_options || [];
        const jobId = await startMap({
          url,
          limit: parseInt(inputValues.map_limit, 10) || 100,
          depth: parseInt(inputValues.map_depth, 10) || 2,
          includeSubdomains: selectedOptions.includes("includeSubdomains"),
          includeExternalLinks: selectedOptions.includes("includeExternalLinks"),
          useBrowser: selectedOptions.includes("useBrowser"),
        });
        return res.json(mapProcessingScreen(jobId));
      }

      case "map_poll": {
        if (!storedData.job_id) {
          return res.json(errorCanvas("Lost track of the map job. Start again.", { retryId: "pick_map" }));
        }
        const result = await pollMap(storedData.job_id);
        if (result.status === "completed") {
          return res.json(mapResultScreen(result));
        }
        if (result.status === "failed") {
          return res.json(errorCanvas(result.error || "Map job failed.", { retryId: "pick_map" }));
        }
        return res.json(mapProcessingScreen(storedData.job_id));
      }

      case "pick_wire":
        return res.json(wireDiscoverFormScreen());

      case "wire_discover_submit": {
        const q = (inputValues.wire_query || "").trim();
        if (!q) {
          return res.json(errorCanvas("Describe what you need to look up.", { retryId: "pick_wire", retryLabel: "Back to form" }));
        }
        // GET /wire/resolve results don't reliably carry a read/write `type`
        // (confirmed live — see the scope note above wireActionTitle()), so
        // this never renders a directly-runnable action list. It groups
        // matches by their `catalog` slug and always bounces through that
        // site's full, type-confirmed catalog entry before anything is
        // offered as runnable.
        const response = await wireDiscover(q, 8);
        const results = extractList(response, ["results", "items"]);
        if (results.length === 0) {
          return res.json(
            canvas([
              text("wire_results_heading", `No matches for: ${q}`, { style: "header" }),
              text("wire_results_empty", "Try a different site name or phrasing.", { style: "muted" }),
              button("pick_wire", "New search", { style: "secondary" }),
              button("go_home", "Back", { style: "link" }),
            ])
          );
        }
        const matchCounts = new Map();
        for (const r of results) {
          const slug = r && r.catalog;
          if (!slug) continue;
          matchCounts.set(slug, (matchCounts.get(slug) || 0) + 1);
        }
        const sites = Array.from(matchCounts, ([slug, matchCount]) => ({ slug, matchCount }));
        if (sites.length === 0) {
          return res.json(
            canvas([
              text("wire_results_heading", `Matches for: ${q}`, { style: "header" }),
              text(
                "wire_results_empty",
                "Anakin found candidate actions but none reported which site they belong to — try Browse the catalog instead.",
                { style: "muted" }
              ),
              button("pick_wire_catalog", "Browse the catalog", { style: "secondary" }),
              button("go_home", "Back", { style: "link" }),
            ])
          );
        }
        if (sites.length === 1) {
          const catalogResponse = await wireCatalog(sites[0].slug);
          const actions = extractList(catalogResponse, ["actions", "results", "items"]);
          const readActions = wireReadCandidates(actions);
          return res.json(
            wireCandidatesScreen(`${sites[0].slug} — read actions for: ${q}`, undefined, readActions, {
              excludedCount: actions.length - readActions.length,
              backId: "pick_wire",
              backLabel: "New search",
            })
          );
        }
        return res.json(wireSitesScreen(q, sites));
      }

      case "pick_wire_catalog": {
        const response = await wireCatalog();
        // Confirmed live: GET /wire/catalog wraps the array as { catalog: [...] }
        // (singular key) — kept "catalogs"/"results"/"items" as fallbacks in
        // case that shape varies by account/plan.
        const rawCatalogs = extractList(response, ["catalog", "catalogs", "results", "items"]);
        const catalogs = rawCatalogs.map((c) => ({
          slug: wireCatalogEntrySlug(c),
          title: wireCatalogEntryTitle(c),
          actionCount: wireCatalogEntryActionCount(c),
        }));
        return res.json(wireCatalogListScreen(catalogs));
      }

      case "wire_run_submit": {
        const selected = storedData.wire_selected;
        if (!selected || !selected.action_id) {
          return res.json(errorCanvas("Lost track of the selected action. Search again.", { retryId: "pick_wire" }));
        }
        const paramsText = (inputValues.wire_params || "").trim();
        let params = {};
        if (paramsText) {
          try {
            params = JSON.parse(paramsText);
          } catch (e) {
            return res.json(errorCanvas(`Parameters are not valid JSON: ${e.message}`, { retryId: "wire_run_retry" }));
          }
        }
        let response;
        try {
          response = await wireSubmitTask({ actionId: selected.action_id, params });
        } catch (err) {
          return res.json(
            wireFailureCanvas({
              message: err.message,
              code: err.code,
              connect_url: err.details && err.details.connect_url,
            })
          );
        }
        if (response.job_id) {
          return res.json(wireActionProcessingScreen(response.job_id, selected.title));
        }
        if (response.status === "failed") {
          return res.json(wireFailureCanvas(response.error || { message: "Action failed." }));
        }
        return res.json(wireActionResultScreen(response.data ?? response, selected.title));
      }

      case "wire_run_retry": {
        const selected = storedData.wire_selected;
        if (!selected || !selected.action_id) {
          return res.json(errorCanvas("Lost track of the selected action. Search again.", { retryId: "pick_wire" }));
        }
        return res.json(wireActionRunFormScreen(selected));
      }

      case "wire_run_poll": {
        if (!storedData.job_id) {
          return res.json(errorCanvas("Lost track of the job. Search again.", { retryId: "pick_wire" }));
        }
        const job = await pollWireJob(storedData.job_id);
        if (job.status === "completed") {
          return res.json(wireActionResultScreen(job.data, storedData.action_title));
        }
        if (job.status === "failed") {
          return res.json(wireFailureCanvas(job.error || { message: "Action failed." }));
        }
        return res.json(wireActionProcessingScreen(storedData.job_id, storedData.action_title));
      }

      case "pick_monitors": {
        const response = await monitorList();
        const monitors = extractList(response, ["monitors", "results", "items"]);
        return res.json(monitorListScreen(monitors));
      }

      default:
        // Unknown component_id — fail safe back to the home screen rather
        // than 500ing, since this can legitimately happen (stale canvas
        // cached in an old conversation, future Intercom-added fields).
        console.warn(`[intercom-anakin] unrecognized component_id: ${componentId}`);
        return res.json(homeScreen());
    }
  } catch (err) {
    console.error("[intercom-anakin] error handling submit", {
      componentId,
      message: err.message,
      status: err.status,
      body: err.body,
    });
    // errorCanvas() already appends its own "go_home" button — don't pass
    // retryId: "go_home" here too, or the response has two components with
    // the same id (caught by curl-testing this against a live server, see
    // SUBMIT.md).
    return res.json(errorCanvas(err.message || "Unexpected error."));
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[intercom-anakin] listening on :${PORT}`);
  });
}

module.exports = {
  app,
  homeScreen,
  scrapeFormScreen,
  searchFormScreen,
  agenticFormScreen,
  crawlFormScreen,
  mapFormScreen,
  wireDiscoverFormScreen,
  verifySignature,
};
