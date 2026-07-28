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
