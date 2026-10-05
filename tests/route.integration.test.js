// Drives api/evidence-request.js the way the platform does, against a local
// mock of Supabase and the evidence receiver. The production webhook is never
// contacted: both env vars point at 127.0.0.1 for the duration of these tests.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

const received = { inserts: [], webhooks: [], duplicateChecks: [] };
let behaviour = { duplicate: [], insertStatus: 201, webhookStatus: 200, hang: false };

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString() || null;

  if (req.url.startsWith("/rest/v1/quiz_leads") && req.method === "GET") {
    received.duplicateChecks.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(behaviour.duplicate));
    return;
  }
  if (req.url.startsWith("/rest/v1/quiz_leads") && req.method === "POST") {
    received.inserts.push(JSON.parse(body));
    res.writeHead(behaviour.insertStatus).end();
    return;
  }
  if (req.url === "/ingress") {
    received.webhooks.push({ body: JSON.parse(body), headers: req.headers });
    if (behaviour.hang) return; // never responds — exercises the abort
    res.writeHead(behaviour.webhookStatus).end();
    return;
  }
  res.writeHead(404).end();
});

let base;
const reset = () => {
  received.inserts.length = 0;
  received.webhooks.length = 0;
  received.duplicateChecks.length = 0;
  behaviour = { duplicate: [], insertStatus: 201, webhookStatus: 200, hang: false };
};

// A minimal stand-in for the platform's req/res pair.
const invoke = async (body, { method = "POST" } = {}) => {
  const { default: handler } = await import("../api/evidence-request.js");
  const res = {
    statusCode: null,
    payload: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await handler({ method, body }, res);
  return res;
};

const VALID = {
  name: "Dave Heatley",
  email: `dave+${Date.now()}@example.com`,
  business_name: "Heatley Rigging",
  town: "Aberdeen",
  service: "rigging",
  score: 45,
};

test.before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_URL = base;
  process.env.SUPABASE_PUBLISHABLE_KEY = "local-test-key";
  process.env.VYNTAR_EVIDENCE_WEBHOOK_URL = `${base}/ingress`;
  process.env.VYNTAR_INGRESS_KEY = "local-ingress-key";
});

test.after(() => server.close());

test("the route saves and posts, and returns ok", async () => {
  reset();
  const res = await invoke(VALID);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true });
  assert.equal(received.inserts.length, 1);
  assert.equal(received.webhooks.length, 1);
});

test("a real crypto request_id starts quiz- and matches the saved row", async () => {
  reset();
  await invoke(VALID);

  const saved = received.inserts[0].request_id;
  assert.match(
    saved,
    /^quiz-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  );
  assert.equal(received.webhooks[0].body.request_id, saved);
});

test("the receiver gets the ingress key header and no email", async () => {
  reset();
  await invoke(VALID);

  const { body, headers } = received.webhooks[0];
  assert.equal(headers["x-vyntar-ingress-key"], "local-ingress-key");
  assert.equal(headers["content-type"], "application/json");
  assert.deepEqual(Object.keys(body).sort(), [
    "business_name",
    "name",
    "request_id",
    "service",
    "source",
    "town",
  ]);
  assert.equal(JSON.stringify(body).includes(VALID.email), false);
});

test("a hanging receiver is aborted and the customer still gets ok", async () => {
  reset();
  behaviour.hang = true;

  const started = Date.now();
  const res = await invoke(VALID);
  const elapsed = Date.now() - started;

  assert.deepEqual(res.payload, { ok: true });
  assert.equal(received.inserts.length, 1, "the lead is still saved");
  assert.ok(elapsed >= 3900, `expected the 4s abort, took ${elapsed}ms`);
  assert.ok(elapsed < 8000, `abort did not bound the wait, took ${elapsed}ms`);
});

test("a failing insert still returns ok and sends nothing", async () => {
  reset();
  behaviour.insertStatus = 500;

  const res = await invoke(VALID);
  assert.deepEqual(res.payload, { ok: true });
  assert.equal(received.webhooks.length, 0);
});

test("a validation failure returns 400 with per-field messages", async () => {
  reset();
  const res = await invoke({ ...VALID, town: "" });

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.ok, false);
  assert.ok(res.payload.errors.town);
  assert.equal(received.inserts.length, 0);
});

test("the honeypot path touches nothing", async () => {
  reset();
  const res = await invoke({ ...VALID, website: "http://bot.test" });

  assert.deepEqual(res.payload, { ok: true });
  assert.equal(received.inserts.length, 0);
  assert.equal(received.webhooks.length, 0);
});

test("a JSON string body is parsed", async () => {
  reset();
  const res = await invoke(JSON.stringify(VALID));

  assert.deepEqual(res.payload, { ok: true });
  assert.equal(received.inserts.length, 1);
});

test("GET is refused", async () => {
  reset();
  const res = await invoke(null, { method: "GET" });

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
  assert.equal(received.inserts.length, 0);
});
