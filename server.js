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
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "AnakinApiError";
    this.status = status;
    this.body = body;
  }
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
      const message =
        (parsed && (parsed.message || parsed.error)) || `Anakin API error ${res.status}`;
      throw new AnakinApiError(message, { status: res.status, body: parsed });
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
      "Scrape a URL, run an AI search, or kick off multi-stage agentic research for this conversation. Copy the result into your reply."
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

module.exports = { app, homeScreen, scrapeFormScreen, searchFormScreen, agenticFormScreen, verifySignature };
