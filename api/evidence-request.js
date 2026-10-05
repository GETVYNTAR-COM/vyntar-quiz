// Server-side route. The ingress key and webhook URL are read from the
// environment here and never reach the browser.

import { randomUUID } from "node:crypto";
import { processSubmission } from "../lib/evidence.js";

// The Supabase project URL and publishable key are the same public values the
// quiz has always used from the browser; env vars allow rotation without a
// code change, and keep previews working with no configuration at all.
const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://cwiwdfzvswjqybhuhhte.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_h27mwjjB0vOOtQG70UOWEw_MHQew6qy";

const parseBody = (raw) => {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const result = await processSubmission({
    body: parseBody(req.body),
    env: process.env,
    supabase: { url: SUPABASE_URL, key: SUPABASE_KEY },
    fetchImpl: fetch,
    uuid: randomUUID,
    // Status and request_id only — no personal data, no secret, no URL.
    log: (status, requestId) =>
      console.log(
        requestId ? `[evidence] ${status} (${requestId})` : `[evidence] ${status}`
      ),
  });

  res.status(result.status).json(result.body);
}
