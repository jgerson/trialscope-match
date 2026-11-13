-- TrialScope Match: the patient record in Postgres (Supabase).
-- Trials and PubMed stay in turbopuffer; this database holds only synthetic patient data.
-- Patient ids are the same text ids the original app uses (its turbopuffer namespaces are ts-patient-{id}).

create table patients (
  id             text primary key,
  name           text not null check (length(trim(name)) > 0),
  date_of_birth  date not null,
  sex            text not null check (sex in ('Female', 'Male')),   -- matches the trials' sex attribute (plus 'All')
  city           text not null default '',
  state          text not null default '',
  specialty      text not null check (specialty in ('Oncology', 'Cardiology')),
  ecog           smallint check (ecog between 0 and 5),            -- performance status, common in oncology criteria
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table conditions (
  id            bigint generated always as identity primary key,
  patient_id    text not null references patients(id),
  description   text not null check (length(trim(description)) > 0),
  icd10_code    text,
  stage         text not null default '',
  is_primary    boolean not null default false,
  status        text not null default 'active' check (status in ('active', 'resolved')),
  diagnosed_on  date,
  updated_at    timestamptz not null default now()
);
create index conditions_patient on conditions (patient_id);
-- At most one active primary diagnosis per patient.
create unique index conditions_one_primary on conditions (patient_id) where is_primary and status = 'active';

create table medications (
  id          bigint generated always as identity primary key,
  patient_id  text not null references patients(id),
  name        text not null check (length(trim(name)) > 0),
  drug_class  text not null default '',
  dose        text not null default '',
  started_on  date,
  stopped_on  date,                                                 -- null = current
  check (stopped_on is null or started_on is null or stopped_on >= started_on)
);
create index medications_current on medications (patient_id) where stopped_on is null;

-- Labs (numeric value and unit) and biomarkers (text result) in one table.
create table observations (
  id           bigint generated always as identity primary key,
  patient_id   text not null references patients(id),
  kind         text not null check (kind in ('lab', 'biomarker')),
  name         text not null check (length(trim(name)) > 0),
  value        numeric,
  unit         text not null default '',
  result       text not null default '',
  observed_on  date not null,
  check ((kind = 'lab' and value is not null and unit <> '') or (kind = 'biomarker' and result <> ''))
);
create index observations_patient on observations (patient_id, name, observed_on desc);

create table notes (
  id          text primary key,
  patient_id  text not null references patients(id),
  title       text not null,
  body        text not null,
  note_type   text not null,
  visit_date  date not null,
  author      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index notes_patient on notes (patient_id, visit_date desc);

-- ── What the app may do ────────────────────────────────────────────
-- The app connects as trialscope_app: read everything, add and change records, never delete or change the schema.
-- Set its password in the Supabase SQL editor:  alter role trialscope_app with password '...';
-- The setup script uses the admin connection instead.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'trialscope_app') then
    create role trialscope_app login;
  end if;
end $$;

grant usage on schema public to trialscope_app;
grant select on patients, conditions, medications, observations, notes to trialscope_app;
grant insert, update on patients, conditions, medications, observations, notes to trialscope_app;
grant usage on all sequences in schema public to trialscope_app;

-- Supabase also exposes tables through its REST API. This app doesn't use it, so row-level security is on and the only
-- policies are for trialscope_app: the anon and authenticated API roles see nothing.
do $$
declare t text;
begin
  foreach t in array array['patients', 'conditions', 'medications', 'observations', 'notes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy app_read on %I for select to trialscope_app using (true)', t);
    execute format('create policy app_insert on %I for insert to trialscope_app with check (true)', t);
    execute format('create policy app_update on %I for update to trialscope_app using (true) with check (true)', t);
  end loop;
end $$;
