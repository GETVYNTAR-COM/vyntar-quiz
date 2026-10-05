-- Adds the evidence-request columns to quiz_leads.
-- Safe on existing rows: every column is nullable and existing rows keep NULL.
-- Run this BEFORE deploying the route that writes these columns.

alter table public.quiz_leads
  add column if not exists request_id text,
  add column if not exists town       text,
  add column if not exists service    text;

-- Unique on request_id, but only where it is present, so the existing rows
-- (and any future row without one) are unaffected.
create unique index if not exists quiz_leads_request_id_uniq
  on public.quiz_leads (request_id)
  where request_id is not null;
