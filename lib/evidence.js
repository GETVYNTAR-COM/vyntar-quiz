// Evidence request pipeline. No dependencies.
//
// Every path returns success to the browser: the customer's self-assessment
// score is computed client-side and must never be withheld because a save or
// a webhook failed.

import {
  validateSubmission,
  normaliseScore,
  resultForScore,
} from "./validation.js";

export const WEBHOOK_TIMEOUT_MS = 4000;
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const SUCCESS = { status: 200, body: { ok: true } };

// Logs carry a status and the request_id only — never the secret, the webhook
// URL, or personal data.
const noopLog = () => {};

export const buildWebhookPayload = (values, requestId) => ({
  request_id: requestId,
  business_name: values.business_name,
  town: values.town,
  service: values.service,
  name: values.name,
  source: "vyntar_quiz",
});

/**
 * Looks for an existing quiz_leads row for this email inside the window.
 * A failed lookup is reported as `unknown` so the main flow is never blocked.
 */
export const findRecentLead = async ({ email, supabase, fetchImpl, now }) => {
  const since = new Date(now - DUPLICATE_WINDOW_MS).toISOString();
  const query =
    `${supabase.url}/rest/v1/quiz_leads` +
    `?select=id&email=eq.${encodeURIComponent(email)}` +
    `&created_at=gte.${encodeURIComponent(since)}&limit=1`;

  try {
    const res = await fetchImpl(query, {
      headers: {
        apikey: supabase.key,
        Authorization: `Bearer ${supabase.key}`,
      },
    });
    if (!res.ok) return { found: false, checked: false };
    const rows = await res.json();
    return { found: Array.isArray(rows) && rows.length > 0, checked: true };
  } catch {
    return { found: false, checked: false };
  }
};

/**
 * The existing quiz_leads write, unchanged in table, columns and headers,
 * plus request_id, town and service in the same row.
 */
export const saveLead = async ({ row, supabase, fetchImpl }) => {
  const res = await fetchImpl(`${supabase.url}/rest/v1/quiz_leads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabase.key,
      Authorization: `Bearer ${supabase.key}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`supabase insert failed: ${res.status}`);
};

/**
 * POSTs the payload to the evidence webhook with a hard 4s abort.
 * Awaited by the caller: an unawaited promise can be killed by the platform
 * once the response has been sent.
 */
export const postEvidenceWebhook = async ({
  payload,
  env,
  fetchImpl,
  log = noopLog,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
}) => {
  const url = env.VYNTAR_EVIDENCE_WEBHOOK_URL;
  const key = env.VYNTAR_INGRESS_KEY;

  if (!url || !key) {
    log("evidence webhook not configured", payload.request_id);
    return { attempted: false, ok: false, reason: "not_configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VYNTAR-INGRESS-KEY": key,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      log(`evidence webhook rejected: ${res.status}`, payload.request_id);
      return { attempted: true, ok: false, reason: "http_error" };
    }
    log("evidence webhook accepted", payload.request_id);
    return { attempted: true, ok: true };
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "timeout" : "network_error";
    log(`evidence webhook ${reason}`, payload.request_id);
    return { attempted: true, ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Runs the full submission in the order the brief defines:
 * validate, honeypot, rate limit, request_id, save, webhook, success.
 */
export const processSubmission = async ({
  body,
  env,
  supabase,
  fetchImpl,
  uuid,
  now = Date.now(),
  log = noopLog,
}) => {
  // a. validate
  const { ok, values, errors } = validateSubmission(body);
  if (!ok) return { status: 400, body: { ok: false, errors } };

  // b. honeypot — look like a success, save nothing, call nothing
  const honeypot = typeof body?.website === "string" ? body.website.trim() : "";
  if (honeypot) {
    log("submission rejected by honeypot", null);
    return SUCCESS;
  }

  // c. rate limit — a repeat inside the window still saves, but sends nothing
  const recent = await findRecentLead({
    email: values.email,
    supabase,
    fetchImpl,
    now,
  });
  if (!recent.checked) log("duplicate check unavailable", null);

  // d. request_id
  const requestId = `quiz-${uuid()}`;

  // e. save — a failure must not cost the customer their score
  const score = normaliseScore(body?.score);
  try {
    await saveLead({
      row: {
        name: values.name,
        email: values.email,
        business: values.business_name,
        score,
        result: resultForScore(score),
        request_id: requestId,
        town: values.town,
        service: values.service,
      },
      supabase,
      fetchImpl,
    });
  } catch {
    log("lead save failed", requestId);
    return SUCCESS;
  }

  if (recent.found) {
    log("duplicate within 24h, webhook skipped", requestId);
    return SUCCESS;
  }

  // f. webhook, only after a successful save
  await postEvidenceWebhook({
    payload: buildWebhookPayload(values, requestId),
    env,
    fetchImpl,
    log,
  });

  // g. success regardless of what the webhook did
  return SUCCESS;
};
