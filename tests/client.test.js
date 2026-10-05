// Guards the front end: the secret stays out of it, the form is complete and
// accessible, and its inline validation agrees with the server's.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateSubmission } from "../lib/validation.js";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const SCRIPT = HTML.slice(HTML.indexOf("<script>") + 8, HTML.indexOf("</script>"));

test("no secret or webhook URL appears in browser code", () => {
  for (const forbidden of [
    "VYNTAR_INGRESS_KEY",
    "VYNTAR_EVIDENCE_WEBHOOK_URL",
    "X-VYNTAR-INGRESS-KEY",
    "sb_publishable",
    "SUPABASE_KEY",
    "service_role",
  ]) {
    assert.equal(
      HTML.includes(forbidden),
      false,
      `${forbidden} must not be in index.html`
    );
  }
});

test("the browser posts to the server route and nowhere else", () => {
  assert.ok(SCRIPT.includes('EVIDENCE_ENDPOINT="/api/evidence-request"'));
  assert.equal(SCRIPT.includes("supabase.co"), false);
  assert.equal(SCRIPT.includes("/rest/v1/quiz_leads"), false);
});

test("the form collects exactly the five required fields plus the honeypot", () => {
  for (const name of ["name", "email", "business_name", "town", "service"]) {
    assert.ok(SCRIPT.includes(`name:"${name}"`), `missing field ${name}`);
  }
  assert.ok(HTML.includes('name="website"'), "missing honeypot");
  assert.ok(HTML.includes('class="hp"'), "honeypot must be visually hidden");
  assert.ok(HTML.includes('tabindex="-1"'), "honeypot must be out of tab order");
});

test("every field has a label, and errors are announced", () => {
  assert.ok(HTML.includes('<label for="${f.id}">${f.label}</label>'));
  assert.ok(HTML.includes('aria-describedby="${f.id}-err"'));
  assert.ok(HTML.includes('role="alert"'));
});

test("the service placeholder is the agreed copy", () => {
  assert.ok(SCRIPT.includes('placeholder:"e.g. roofer, plumber, cafe"'));
});

test("the two required copy lines are present", () => {
  assert.ok(
    HTML.includes(
      "VYNTAR will verify your real Google Maps and search visibility."
    )
  );
  assert.ok(
    HTML.includes("We'll use your details to contact you about your check.")
  );
});

test("the front end never claims the live Google evidence is instant", () => {
  const text = HTML.toLowerCase();
  for (const claim of [
    "instant audit",
    "instant evidence",
    "instant report",
    "instantly verif",
    "live results now",
  ]) {
    assert.equal(text.includes(claim), false, `found claim: ${claim}`);
  }
});

test("a transport failure still shows the score", () => {
  // The catch arm must reach showResults() and must not re-enable the form.
  const catchArm = SCRIPT.slice(SCRIPT.lastIndexOf("}catch(e){"));
  assert.ok(catchArm.includes("showResults()"));
});

test("the score calculation and the five questions are untouched", () => {
  assert.ok(SCRIPT.includes("score+=Q[cur].s[i]"));
  const questions = SCRIPT.match(/\{q:"/g) || [];
  assert.equal(questions.length, 5);
  for (const band of ['"Strong"', '"Average"', '"Weak"', '"Critical"']) {
    assert.ok(SCRIPT.includes(band));
  }
});

test("inline validation agrees with the server on every sample", () => {
  // Rebuild the client's rules from the literals in the page, so the two
  // copies cannot drift apart unnoticed.
  const grab = (name) => {
    const line = SCRIPT.split("\n").find((l) => l.startsWith(`const ${name}=/`));
    assert.ok(line, `missing ${name}`);
    const body = line.slice(`const ${name}=`.length, line.lastIndexOf("/i") + 2);
    return eval(body); // a regex literal read from our own file
  };
  const SCHEME_RE = grab("SCHEME_RE");
  const BARE_DOMAIN_RE = grab("BARE_DOMAIN_RE");

  const clientRejects = (field, value) => {
    if (!value) return true;
    if (field === "email") return SCHEME_RE.test(value);
    return SCHEME_RE.test(value) || BARE_DOMAIN_RE.test(value);
  };

  const samples = [
    "Dave Heatley",
    "J.D. Joinery",
    "St. Albans Roofing",
    "Heatley Rigging Ltd",
    "roofer",
    "Aberdeen",
    "http://spam.test",
    "www.example.com",
    "example.com",
    "visit us at foo.co.uk today",
    "",
  ];

  for (const value of samples) {
    for (const field of ["name", "business_name", "town", "service"]) {
      const base = {
        name: "Dave",
        email: "dave@example.com",
        business_name: "Rigging",
        town: "Aberdeen",
        service: "rigging",
      };
      const server = validateSubmission({ ...base, [field]: value });
      const serverRejects = Boolean(server.errors[field]);
      assert.equal(
        clientRejects(field, value),
        serverRejects,
        `disagreement on ${field} = ${JSON.stringify(value)}`
      );
    }
  }
});

test("an email containing a scheme is rejected by both sides", () => {
  const { errors } = validateSubmission({
    name: "Dave",
    email: "http://evil.test/dave@example.com",
    business_name: "Rigging",
    town: "Aberdeen",
    service: "rigging",
  });
  assert.ok(errors.email);
});

test("a plain email address is accepted", () => {
  const { ok } = validateSubmission({
    name: "Dave",
    email: "dave@example.co.uk",
    business_name: "Rigging",
    town: "Aberdeen",
    service: "rigging",
  });
  assert.equal(ok, true);
});
