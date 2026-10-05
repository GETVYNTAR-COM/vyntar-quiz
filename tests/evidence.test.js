import test from "node:test";
import assert from "node:assert/strict";

import {
  processSubmission,
  postEvidenceWebhook,
  buildWebhookPayload,
  WEBHOOK_TIMEOUT_MS,
} from "../lib/evidence.js";
import { validateSubmission, containsUrl } from "../lib/validation.js";

const SUPABASE = { url: "https://supabase.test", key: "test-key" };
const ENV = {
  VYNTAR_EVIDENCE_WEBHOOK_URL: "https://webhook.test/ingress",
  VYNTAR_INGRESS_KEY: "test-ingress-key",
};

const VALID = {
  name: "Dave Heatley",
  email: "dave@example.com",
  business_name: "Heatley Rigging",
  town: "Aberdeen",
  service: "rigging",
  score: 45,
};

const isInsert = (url, opts) =>
  url.includes("/quiz_leads") && opts?.method === "POST";
const isDuplicateCheck = (url, opts) =>
  url.includes("/quiz_leads") && !opts?.method;

/**
 * A mocked fetch. Nothing in this suite touches a real network.
 * duplicate: rows returned by the 24h lookup.
 */
const makeFetch = ({
  duplicate = [],
  duplicateStatus = 200,
  insertOk = true,
  webhook = { ok: true, status: 200 },
} = {}) => {
  const calls = { inserts: [], webhooks: [], duplicateChecks: [] };

  const impl = async (url, opts = {}) => {
    if (isDuplicateCheck(url, opts)) {
      calls.duplicateChecks.push({ url, opts });
      return {
        ok: duplicateStatus === 200,
        status: duplicateStatus,
        json: async () => duplicate,
      };
    }
    if (isInsert(url, opts)) {
      calls.inserts.push({ url, opts, row: JSON.parse(opts.body) });
      return { ok: insertOk, status: insertOk ? 201 : 500 };
    }
    // webhook
    calls.webhooks.push({ url, opts, payload: JSON.parse(opts.body) });
    if (webhook.throw) throw webhook.throw;
    return { ok: webhook.ok, status: webhook.status };
  };

  return { impl, calls };
};

const run = (overrides = {}) => {
  const { body = VALID, env = ENV, fetchMock, ...rest } = overrides;
  const mock = fetchMock || makeFetch();
  return processSubmission({
    body,
    env,
    supabase: SUPABASE,
    fetchImpl: mock.impl,
    uuid: () => "11111111-2222-3333-4444-555555555555",
    log: () => {},
    ...rest,
  }).then((result) => ({ result, calls: mock.calls }));
};

// --- valid submit ----------------------------------------------------------

test("valid submit saves the lead and posts the webhook", async () => {
  const { result, calls } = await run();

  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(calls.inserts.length, 1);
  assert.equal(calls.webhooks.length, 1);
});

test("request_id starts with quiz- and is the same value saved and sent", async () => {
  const { calls } = await run();

  const saved = calls.inserts[0].row.request_id;
  const sent = calls.webhooks[0].payload.request_id;

  assert.ok(saved.startsWith("quiz-"), `expected quiz- prefix, got ${saved}`);
  assert.equal(sent, saved);
});

test("webhook payload carries exactly the six agreed fields and no email", async () => {
  const { calls } = await run();
  const payload = calls.webhooks[0].payload;

  assert.deepEqual(Object.keys(payload).sort(), [
    "business_name",
    "name",
    "request_id",
    "service",
    "source",
    "town",
  ]);
  assert.equal(payload.source, "vyntar_quiz");
  assert.equal("email" in payload, false);
  assert.equal(JSON.stringify(payload).includes(VALID.email), false);
});

test("webhook sends the ingress key header and never the key in the body", async () => {
  const { calls } = await run();
  const { opts } = calls.webhooks[0];

  assert.equal(opts.headers["X-VYNTAR-INGRESS-KEY"], ENV.VYNTAR_INGRESS_KEY);
  assert.equal(opts.headers["Content-Type"], "application/json");
  assert.equal(opts.body.includes(ENV.VYNTAR_INGRESS_KEY), false);
});

test("the saved row keeps the existing columns and adds the three new ones", async () => {
  const { calls } = await run();
  const row = calls.inserts[0].row;

  // existing write, unchanged
  assert.equal(row.name, VALID.name);
  assert.equal(row.email, VALID.email);
  assert.equal(row.business, VALID.business_name);
  assert.equal(row.score, 45);
  assert.equal(row.result, "Weak");
  // new columns, same row
  assert.equal(row.town, "Aberdeen");
  assert.equal(row.service, "rigging");
  assert.ok(row.request_id);

  assert.equal(calls.inserts[0].opts.headers.Prefer, "return=minimal");
});

test("fields are trimmed before saving and sending", async () => {
  const { calls } = await run({
    body: { ...VALID, name: "  Dave  ", town: "  Aberdeen ", service: " roofer " },
  });

  assert.equal(calls.inserts[0].row.name, "Dave");
  assert.equal(calls.webhooks[0].payload.town, "Aberdeen");
  assert.equal(calls.webhooks[0].payload.service, "roofer");
});

// --- validation failures --------------------------------------------------

for (const field of ["name", "email", "business_name", "town", "service"]) {
  test(`missing ${field} is rejected with a message and no side effects`, async () => {
    const { result, calls } = await run({ body: { ...VALID, [field]: "" } });

    assert.equal(result.status, 400);
    assert.ok(result.body.errors[field]);
    assert.equal(calls.inserts.length, 0);
    assert.equal(calls.webhooks.length, 0);
  });
}

test("whitespace-only values count as missing", async () => {
  const { result } = await run({ body: { ...VALID, town: "   " } });
  assert.equal(result.status, 400);
  assert.ok(result.body.errors.town);
});

test("length limits are enforced at 80 / 40 / 40", async () => {
  const over = await run({
    body: {
      ...VALID,
      business_name: "b".repeat(81),
      town: "t".repeat(41),
      service: "s".repeat(41),
    },
  });
  assert.equal(over.result.status, 400);
  assert.ok(over.result.body.errors.business_name);
  assert.ok(over.result.body.errors.town);
  assert.ok(over.result.body.errors.service);

  const atLimit = await run({
    body: {
      ...VALID,
      business_name: "b".repeat(80),
      town: "t".repeat(40),
      service: "s".repeat(40),
    },
  });
  assert.equal(atLimit.result.status, 200);
});

test("a URL in any field is rejected", async () => {
  for (const [field, value] of [
    ["name", "http://spam.test"],
    ["business_name", "Visit www.example.com"],
    ["town", "aberdeen.co.uk"],
    ["service", "roofing https://x.io"],
  ]) {
    const { result, calls } = await run({ body: { ...VALID, [field]: value } });
    assert.equal(result.status, 400, `${field} should be rejected`);
    assert.ok(result.body.errors[field]);
    assert.equal(calls.inserts.length, 0);
  }
});

test("legitimate UK business names with dots are not treated as URLs", () => {
  assert.equal(containsUrl("J.D. Joinery"), false);
  assert.equal(containsUrl("St. Albans Roofing"), false);
  assert.equal(containsUrl("A.B.C. Plumbing Ltd"), false);
  assert.equal(containsUrl("example.com"), true);
});

test("an invalid email shape is rejected", async () => {
  const { result } = await run({ body: { ...VALID, email: "not-an-email" } });
  assert.equal(result.status, 400);
  assert.ok(result.body.errors.email);
});

test("validateSubmission returns trimmed values alongside errors", () => {
  const { ok, values } = validateSubmission({ ...VALID, name: " Dave " });
  assert.equal(ok, true);
  assert.equal(values.name, "Dave");
});

// --- honeypot -------------------------------------------------------------

test("a filled honeypot looks like success but saves and sends nothing", async () => {
  const { result, calls } = await run({
    body: { ...VALID, website: "http://bot.test" },
  });

  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(calls.inserts.length, 0);
  assert.equal(calls.webhooks.length, 0);
  assert.equal(calls.duplicateChecks.length, 0);
});

test("an empty honeypot does not block a real submission", async () => {
  const { result, calls } = await run({ body: { ...VALID, website: "" } });
  assert.equal(result.status, 200);
  assert.equal(calls.inserts.length, 1);
});

// --- rate limit -----------------------------------------------------------

test("a repeat email within 24h still saves but skips the webhook", async () => {
  const mock = makeFetch({ duplicate: [{ id: 1 }] });
  const { result, calls } = await run({ fetchMock: mock });

  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(calls.inserts.length, 1, "the lead is still captured");
  assert.equal(calls.webhooks.length, 0, "no second evidence request");
});

test("the duplicate lookup is scoped to this email and a 24h window", async () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const mock = makeFetch();
  await run({ fetchMock: mock, now });

  const url = mock.calls.duplicateChecks[0].url;
  assert.ok(url.includes(`email=eq.${encodeURIComponent(VALID.email)}`));
  assert.ok(url.includes(encodeURIComponent("2026-10-04T12:00:00.000Z")));
});

test("an unavailable duplicate lookup does not block the submission", async () => {
  const mock = makeFetch({ duplicateStatus: 500 });
  const { result, calls } = await run({ fetchMock: mock });

  assert.equal(result.status, 200);
  assert.equal(calls.inserts.length, 1);
  assert.equal(calls.webhooks.length, 1);
});

// --- webhook failure modes ------------------------------------------------

test("a webhook timeout still returns success", async () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  const mock = makeFetch({ webhook: { throw: abort } });
  const { result, calls } = await run({ fetchMock: mock });

  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(calls.inserts.length, 1, "the lead is still saved");
});

test("a webhook 500 still returns success", async () => {
  const mock = makeFetch({ webhook: { ok: false, status: 500 } });
  const { result, calls } = await run({ fetchMock: mock });

  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(calls.inserts.length, 1);
});

test("a webhook network error still returns success", async () => {
  const mock = makeFetch({ webhook: { throw: new TypeError("fetch failed") } });
  const { result } = await run({ fetchMock: mock });
  assert.deepEqual(result, { status: 200, body: { ok: true } });
});

test("the webhook is aborted after the 4s timeout", async () => {
  const seen = {};
  const slowFetch = (url, opts) =>
    new Promise((_resolve, reject) => {
      seen.hasSignal = Boolean(opts.signal);
      opts.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

  assert.equal(WEBHOOK_TIMEOUT_MS, 4000);

  const outcome = await postEvidenceWebhook({
    payload: buildWebhookPayload(VALID, "quiz-abc"),
    env: ENV,
    fetchImpl: slowFetch,
    timeoutMs: 5, // same mechanism, kept short so the suite stays fast
  });

  assert.equal(seen.hasSignal, true);
  assert.deepEqual(outcome, { attempted: true, ok: false, reason: "timeout" });
});

// --- missing environment variables ---------------------------------------

for (const env of [
  {},
  { VYNTAR_EVIDENCE_WEBHOOK_URL: "https://webhook.test/ingress" },
  { VYNTAR_INGRESS_KEY: "test-ingress-key" },
]) {
  test(`missing env (${Object.keys(env).join(",") || "none"}) skips the webhook and still succeeds`, async () => {
    const mock = makeFetch();
    const { result, calls } = await run({ env, fetchMock: mock });

    assert.deepEqual(result, { status: 200, body: { ok: true } });
    assert.equal(calls.inserts.length, 1, "the lead is still saved");
    assert.equal(calls.webhooks.length, 0, "nothing is posted");
  });
}

test("the not-configured log carries no personal data", async () => {
  const logged = [];
  const mock = makeFetch();
  await processSubmission({
    body: VALID,
    env: {},
    supabase: SUPABASE,
    fetchImpl: mock.impl,
    uuid: () => "abc",
    log: (status, requestId) => logged.push(`${status} ${requestId ?? ""}`),
  });

  const line = logged.find((l) => l.includes("not configured"));
  assert.ok(line, "expected the not-configured line");
  for (const secret of [VALID.email, VALID.name, VALID.business_name]) {
    assert.equal(logged.join("|").includes(secret), false);
  }
});

// --- failed lead save ----------------------------------------------------

test("a failed save still returns success and skips the webhook", async () => {
  const mock = makeFetch({ insertOk: false });
  const { result, calls } = await run({ fetchMock: mock });

  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(calls.webhooks.length, 0, "no webhook without a saved row");
});

test("a failed save logs a short status with the request_id and no personal data", async () => {
  const logged = [];
  const mock = makeFetch({ insertOk: false });
  await processSubmission({
    body: VALID,
    env: ENV,
    supabase: SUPABASE,
    fetchImpl: mock.impl,
    uuid: () => "11111111",
    log: (status, requestId) => logged.push({ status, requestId }),
  });

  const entry = logged.find((l) => l.status === "lead save failed");
  assert.ok(entry);
  assert.equal(entry.requestId, "quiz-11111111");
  const dump = JSON.stringify(logged);
  for (const secret of [VALID.email, VALID.name, VALID.business_name]) {
    assert.equal(dump.includes(secret), false);
  }
});

// --- score handling ------------------------------------------------------

test("the stored result is derived from the score, not taken from the body", async () => {
  const cases = [
    [100, "Strong"],
    [80, "Strong"],
    [50, "Average"],
    [25, "Weak"],
    [0, "Critical"],
  ];
  for (const [score, expected] of cases) {
    const mock = makeFetch();
    await run({ body: { ...VALID, score, result: "Tampered" }, fetchMock: mock });
    assert.equal(mock.calls.inserts[0].row.result, expected);
    assert.equal(mock.calls.inserts[0].row.score, score);
  }
});

test("an out-of-range or missing score is clamped rather than rejected", async () => {
  const mock = makeFetch();
  await run({ body: { ...VALID, score: 999 }, fetchMock: mock });
  assert.equal(mock.calls.inserts[0].row.score, 100);

  const mock2 = makeFetch();
  const { result } = await run({ body: { ...VALID, score: undefined }, fetchMock: mock2 });
  assert.equal(result.status, 200);
  assert.equal(mock2.calls.inserts[0].row.score, 0);
});
