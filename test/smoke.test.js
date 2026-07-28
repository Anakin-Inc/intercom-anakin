"use strict";

// Smoke test for the Canvas Kit webhook contract itself — does NOT call the
// real Anakin API (no network dependency, no API key required) and does NOT
// need a real Intercom account. It only proves this server's /canvas/*
// responses are well-formed against the documented request/response shapes
// confirmed in README.md (canvas.content.components array, component field
// names, component_id-based routing, stored_data round-tripping).

const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../server.js");

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// server.js reads ANAKIN_API_KEY into a module-level const at require() time
// (deliberately — see server.js's comment on that constant), not at call
// time the way INTERCOM_CLIENT_SECRET is. So setting process.env.ANAKIN_API_KEY
// after `require("../server.js")` has already run (as it has, at the top of
// this file) has no effect on the already-imported `app`. Tests that need a
// "configured" server clear the require cache and re-require a fresh module
// instance under the desired env instead — isolated from the shared `app`
// used by every other test in this file.
async function startFreshServerWithEnv(envOverrides) {
  const originalValues = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    originalValues[k] = process.env[k];
    process.env[k] = v;
  }
  const serverPath = require.resolve("../server.js");
  delete require.cache[serverPath];
  const freshModule = require("../server.js");
  const server = await new Promise((resolve) => {
    const s = freshModule.app.listen(0, () => resolve(s));
  });
  return {
    server,
    restore: () => {
      for (const [k, v] of Object.entries(originalValues)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete require.cache[serverPath];
    },
  };
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function postCanvas(server, path, body) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

function assertValidCanvas(payload) {
  assert.ok(payload.canvas, "response must have a top-level canvas object");
  assert.ok(payload.canvas.content, "canvas must have a content object");
  assert.ok(Array.isArray(payload.canvas.content.components), "content.components must be an array");
  const seenIds = new Set();
  for (const c of payload.canvas.content.components) {
    assert.ok(typeof c.type === "string" && c.type.length > 0, "every component needs a string type");
    if (c.id) {
      assert.ok(!seenIds.has(c.id), `duplicate component id in one canvas: ${c.id}`);
      seenIds.add(c.id);
    }
  }
}

test("no INTERCOM_CLIENT_SECRET set -> signature check is skipped, initialize succeeds", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/initialize", {
    workspace_id: "test_workspace",
    conversation: { id: "12345" },
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
  const ids = json.canvas.content.components.map((c) => c.id);
  assert.ok(ids.includes("actions"), "home screen should include the action list");
});

test("submit with unknown component_id falls back to home screen instead of erroring", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "does_not_exist",
    input_values: {},
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("pick_scrape returns the scrape form with url input and submit button", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "pick_scrape",
    input_values: {},
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
  const components = json.canvas.content.components;
  assert.ok(components.some((c) => c.type === "input" && c.id === "scrape_url"));
  assert.ok(components.some((c) => c.type === "button" && c.id === "scrape_submit"));
});

test("scrape_submit with no URL returns an error canvas, not a 500", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "scrape_submit",
    input_values: { scrape_url: "" },
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
  assert.ok(json.canvas.content.components.some((c) => c.style === "error"));
});

test("scrape_poll with no stored_data.job_id returns a recoverable error canvas", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "scrape_poll",
    input_values: {},
    current_canvas: { stored_data: {} },
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("agentic_submit with invalid JSON schema returns an error canvas without calling Anakin", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "agentic_submit",
    input_values: { agentic_prompt: "test prompt", agentic_schema: "{not valid json" },
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
  assert.ok(json.canvas.content.components.some((c) => c.style === "error"));
});

test("scrape_submit with no ANAKIN_API_KEY configured returns a single-go_home error canvas (regression: no duplicate component ids)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  // ANAKIN_API_KEY is intentionally unset in this test run, so the server's
  // own anakinRequest() throws before any network call is made — this
  // exercises the top-level catch-all error path in the /canvas/submit
  // handler, which previously passed retryId: "go_home" into errorCanvas()
  // (which already appends its own go_home button), producing two
  // components with the same id in one canvas. Fixed by dropping the
  // redundant retryId; this test guards the regression.
  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "scrape_submit",
    input_values: { scrape_url: "https://example.com" },
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("healthz reports whether ANAKIN_API_KEY is configured", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const res = await fetch(`${baseUrl(server)}/healthz`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(typeof json.anakinConfigured, "boolean");
});

test("signature verification rejects a bad X-Body-Signature when a client secret is configured", async () => {
  const { verifySignature } = require("../server.js");
  const originalSecret = process.env.INTERCOM_CLIENT_SECRET;
  process.env.INTERCOM_CLIENT_SECRET = "test-secret";
  try {
    const fakeReq = {
      get: () => "deadbeef",
      rawBody: Buffer.from('{"a":1}'),
    };
    const result = verifySignature(fakeReq);
    assert.equal(result.ok, false);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.INTERCOM_CLIENT_SECRET;
    } else {
      process.env.INTERCOM_CLIENT_SECRET = originalSecret;
    }
  }
});

// ─── New routes: crawl, map, wire, monitors ────────────────────────────────
//
// Same no-network, no-API-key philosophy as the tests above: these exercise
// the Canvas Kit contract (form rendering, input validation, stored_data
// recovery) without ever reaching api.anakin.io. Routes that DO need a real
// network call (crawl_submit/map_submit/wire_discover_submit/pick_monitors
// with a valid input) are covered by the "no ANAKIN_API_KEY configured"
// regression tests below instead, the same way the original scrape_submit
// regression test works — proving the top-level error path renders a
// well-formed, non-duplicate-id canvas rather than crashing.

test("home screen lists all seven actions, including the four added in this change", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { json } = await postCanvas(server, "/canvas/initialize", {});
  assertValidCanvas(json);
  const actionsList = json.canvas.content.components.find((c) => c.id === "actions");
  const ids = actionsList.items.map((i) => i.id);
  assert.deepEqual(ids, ["pick_scrape", "pick_search", "pick_agentic", "pick_crawl", "pick_map", "pick_wire", "pick_monitors"]);
});

test("pick_crawl returns the crawl form with url input and submit button", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", { component_id: "pick_crawl", input_values: {} });
  assert.equal(status, 200);
  assertValidCanvas(json);
  const components = json.canvas.content.components;
  assert.ok(components.some((c) => c.type === "input" && c.id === "crawl_url"));
  assert.ok(components.some((c) => c.type === "button" && c.id === "crawl_submit"));
});

test("crawl_submit with no URL returns an error canvas, not a 500", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "crawl_submit",
    input_values: { crawl_url: "" },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
  assert.ok(json.canvas.content.components.some((c) => c.style === "error"));
});

test("crawl_poll with no stored_data.job_id returns a recoverable error canvas", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "crawl_poll",
    input_values: {},
    current_canvas: { stored_data: {} },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("pick_map returns the map form with url input and submit button", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", { component_id: "pick_map", input_values: {} });
  assert.equal(status, 200);
  assertValidCanvas(json);
  const components = json.canvas.content.components;
  assert.ok(components.some((c) => c.type === "input" && c.id === "map_url"));
  assert.ok(components.some((c) => c.type === "button" && c.id === "map_submit"));
});

test("map_submit with no URL returns an error canvas, not a 500", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "map_submit",
    input_values: { map_url: "" },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
  assert.ok(json.canvas.content.components.some((c) => c.style === "error"));
});

test("map_poll with no stored_data.job_id returns a recoverable error canvas", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "map_poll",
    input_values: {},
    current_canvas: { stored_data: {} },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("pick_wire returns the Wire discover form with query textarea and both entry points", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", { component_id: "pick_wire", input_values: {} });
  assert.equal(status, 200);
  assertValidCanvas(json);
  const components = json.canvas.content.components;
  assert.ok(components.some((c) => c.type === "textarea" && c.id === "wire_query"));
  assert.ok(components.some((c) => c.type === "button" && c.id === "wire_discover_submit"));
  assert.ok(components.some((c) => c.type === "button" && c.id === "pick_wire_catalog"));
});

test("wire_discover_submit with no query returns an error canvas, not a 500", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_discover_submit",
    input_values: { wire_query: "" },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
  assert.ok(json.canvas.content.components.some((c) => c.style === "error"));
});

test("wire_pick_0 with no stored wire_candidates returns a recoverable error canvas", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_pick_0",
    input_values: {},
    current_canvas: { stored_data: {} },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("wire_pick_0 with a stored read candidate renders the run form, filtering out write actions never reaches here (covered by unit-level filtering)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_pick_0",
    input_values: {},
    current_canvas: {
      stored_data: {
        wire_candidates: [
          { action_id: "walmart.get_product", title: "Get Walmart product", auth_mode: "none", credits: 2 },
        ],
      },
    },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
  const components = json.canvas.content.components;
  assert.ok(components.some((c) => c.type === "textarea" && c.id === "wire_params"));
  assert.ok(components.some((c) => c.type === "button" && c.id === "wire_run_submit"));
  assert.equal(json.canvas.stored_data.wire_selected.action_id, "walmart.get_product");
});

test("wire_catalog_pick_0 with no stored wire_catalogs returns a recoverable error canvas", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_catalog_pick_0",
    input_values: {},
    current_canvas: { stored_data: {} },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("wire_run_submit with no stored wire_selected returns a recoverable error canvas", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_run_submit",
    input_values: { wire_params: "{}" },
    current_canvas: { stored_data: {} },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("wire_run_submit with invalid JSON params returns an error canvas without calling Anakin", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_run_submit",
    input_values: { wire_params: "{not valid json" },
    current_canvas: { stored_data: { wire_selected: { action_id: "walmart.get_product", title: "Get product" } } },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
  assert.ok(json.canvas.content.components.some((c) => c.style === "error"));
});

test("wire_run_poll with no stored_data.job_id returns a recoverable error canvas", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_run_poll",
    input_values: {},
    current_canvas: { stored_data: {} },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("monitor_pick_0 with no stored monitors returns a recoverable error canvas", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "monitor_pick_0",
    input_values: {},
    current_canvas: { stored_data: {} },
  });
  assert.equal(status, 200);
  assertValidCanvas(json);
});

test("pick_monitors with no ANAKIN_API_KEY configured returns a single-go_home error canvas (same regression class as scrape_submit)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { status, json } = await postCanvas(server, "/canvas/submit", { component_id: "pick_monitors", input_values: {} });
  assert.equal(status, 200);
  assertValidCanvas(json); // assertValidCanvas already rejects duplicate component ids
  assert.ok(json.canvas.content.components.some((c) => c.style === "error"));
});

test("crawl_submit, map_submit, and wire_discover_submit with no ANAKIN_API_KEY configured all return single-go_home error canvases", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const cases = [
    { component_id: "crawl_submit", input_values: { crawl_url: "https://example.com" } },
    { component_id: "map_submit", input_values: { map_url: "https://example.com" } },
    { component_id: "wire_discover_submit", input_values: { wire_query: "check an order on shopify" } },
  ];
  for (const body of cases) {
    const { status, json } = await postCanvas(server, "/canvas/submit", body);
    assert.equal(status, 200);
    assertValidCanvas(json);
    assert.ok(json.canvas.content.components.some((c) => c.style === "error"), `${body.component_id} should render an error canvas`);
  }
});

test("wire_run_submit surfaces Wire's nested error envelope message correctly, not '[object Object]' (regression: anakinRequest previously only handled the flat error shape)", async (t) => {
  const { server, restore } = await startFreshServerWithEnv({ ANAKIN_API_KEY: "test-key" });
  const originalFetch = global.fetch;
  // Only intercept the server's own outbound call to api.anakin.io — the
  // test client's loopback call to the local server (postCanvas below) also
  // goes through this same process-global fetch and must pass through
  // untouched, or it never reaches the server at all.
  global.fetch = async (url, init) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (!urlStr.includes("api.anakin.io")) return originalFetch(url, init);
    return new Response(
      JSON.stringify({ status: "error", error: { code: "VALIDATION_ERROR", message: "params.order_id is required" } }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  };
  t.after(() => {
    server.close();
    global.fetch = originalFetch;
    restore();
  });

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_run_submit",
    input_values: { wire_params: "" },
    current_canvas: { stored_data: { wire_selected: { action_id: "walmart.get_product", title: "Get product" } } },
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
  const errorComponent = json.canvas.content.components.find((c) => c.style === "error");
  assert.ok(errorComponent, "expected an error-styled component");
  assert.match(errorComponent.text, /params\.order_id is required/);
  assert.doesNotMatch(errorComponent.text, /\[object Object\]/);
});

test("wire_run_poll renders a 'Connect account' button when the job fails with AUTH_REQUIRED and a connect_url", async (t) => {
  const { server, restore } = await startFreshServerWithEnv({ ANAKIN_API_KEY: "test-key" });
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (!urlStr.includes("api.anakin.io")) return originalFetch(url, init);
    return new Response(
      JSON.stringify({
        status: "failed",
        error: { code: "AUTH_REQUIRED", message: "Sign in required", connect_url: "https://anakin.io/connect/shopify" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  t.after(() => {
    server.close();
    global.fetch = originalFetch;
    restore();
  });

  const { status, json } = await postCanvas(server, "/canvas/submit", {
    component_id: "wire_run_poll",
    input_values: {},
    current_canvas: { stored_data: { job_id: "job_123", job_type: "wire", action_title: "Get product" } },
  });

  assert.equal(status, 200);
  assertValidCanvas(json);
  const connectButton = json.canvas.content.components.find((c) => c.id === "wire_connect_url");
  assert.ok(connectButton, "expected a wire_connect_url button");
  assert.equal(connectButton.action.type, "url");
  assert.equal(connectButton.action.url, "https://anakin.io/connect/shopify");
});

test("signature verification accepts a correctly computed X-Body-Signature", async () => {
  const crypto = require("node:crypto");
  const { verifySignature } = require("../server.js");
  const originalSecret = process.env.INTERCOM_CLIENT_SECRET;
  process.env.INTERCOM_CLIENT_SECRET = "test-secret";
  try {
    const rawBody = Buffer.from('{"a":1}');
    const goodSignature = crypto.createHmac("sha256", "test-secret").update(rawBody).digest("hex");
    const fakeReq = { get: () => goodSignature, rawBody };
    const result = verifySignature(fakeReq);
    assert.equal(result.ok, true);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.INTERCOM_CLIENT_SECRET;
    } else {
      process.env.INTERCOM_CLIENT_SECRET = originalSecret;
    }
  }
});
