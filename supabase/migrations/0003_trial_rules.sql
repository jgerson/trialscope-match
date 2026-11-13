-- "Find patients for this trial": a trial's free-text eligibility criteria, turned into checkable rules by one model
-- call (lib/trial-match.ts), cached here so the call happens once per trial rather than on every view.
--
-- criteria_hash covers the criteria text, the trial's age and sex limits and the extraction prompt's version, so an
-- amended protocol (or a changed prompt) is extracted again instead of reusing stale rules.
--
-- Safe to run more than once (npm run migrate).

create table if not exists trial_rules (
  nct            text primary key check (nct ~ '^NCT[0-9]{8}$'),
  criteria_hash  text not null,
  rules          jsonb not null,               -- [{ kind, section, criterion, ... }], see lib/trial-match.ts
  not_checkable  jsonb not null default '[]',  -- criteria the record can't answer, as short phrases
  model          text not null,
  in_tokens      int,
  out_tokens     int,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The app reads and refreshes the cache; like every other table, it can't delete.
grant select, insert, update on trial_rules to trialscope_app;
