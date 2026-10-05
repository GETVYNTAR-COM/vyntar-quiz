// Shared validation for the evidence request. No dependencies.

export const LIMITS = {
  name: 80,
  email: 120,
  business_name: 80,
  town: 40,
  service: 40,
};

export const FIELDS = ["name", "email", "business_name", "town", "service"];

const LABELS = {
  name: "Your name",
  email: "Email address",
  business_name: "Business name",
  town: "Town or city",
  service: "Service",
};

// A scheme or a www. host. Always a URL, in any field.
const SCHEME_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)/i;

// A bare domain ending in a known TLD. Uses a TLD allowlist so legitimate UK
// business names ("J.D. Joinery", "St. Albans Roofing") are not rejected.
// Not applied to the email field, where a domain is expected.
const BARE_DOMAIN_PATTERN =
  /\b[a-z0-9][a-z0-9-]*\.(?:co\.uk|org\.uk|me\.uk|com|net|org|io|uk|biz|info|dev|app|shop|store|online|site|xyz|me|ltd|agency|services|solutions|email|co)\b/i;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export const containsUrl = (value) => {
  const text = String(value);
  return SCHEME_PATTERN.test(text) || BARE_DOMAIN_PATTERN.test(text);
};

// An email address contains a domain by definition, so only a scheme or a
// www. host counts as a URL here.
export const emailContainsUrl = (value) => SCHEME_PATTERN.test(String(value));

/**
 * Validates and normalises a submission.
 * Returns { ok, values, errors } — errors is keyed by field name.
 */
export const validateSubmission = (raw) => {
  const input = raw && typeof raw === "object" ? raw : {};
  const values = {};
  const errors = {};

  for (const field of FIELDS) {
    const value = typeof input[field] === "string" ? input[field].trim() : "";
    values[field] = value;

    if (!value) {
      errors[field] = `${LABELS[field]} is required.`;
      continue;
    }
    // Defensive cap applied before the per-field limits so an oversized
    // payload can never reach the database or the webhook.
    if (value.length > 200) {
      errors[field] = `${LABELS[field]} is too long.`;
      continue;
    }
    if (value.length > LIMITS[field]) {
      errors[field] = `${LABELS[field]} must be ${LIMITS[field]} characters or fewer.`;
      continue;
    }
    const hasUrl =
      field === "email" ? emailContainsUrl(value) : containsUrl(value);
    if (hasUrl) {
      errors[field] = `${LABELS[field]} cannot contain a web address.`;
      continue;
    }
    if (field === "email" && !EMAIL_PATTERN.test(value)) {
      errors[field] = "Enter a valid email address.";
    }
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
};

// Mirrors the client-side score bands so the stored result never depends on
// a value the browser could tamper with.
export const resultForScore = (score) => {
  if (score >= 80) return "Strong";
  if (score >= 50) return "Average";
  if (score >= 25) return "Weak";
  return "Critical";
};

export const normaliseScore = (value) => {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score)));
};
