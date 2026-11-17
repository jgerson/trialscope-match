// The patient record, from Supabase Postgres: patients, conditions, medications and observations (labs and biomarkers).
// Notes are in turbopuffer (lib/notes.ts). Reads build the same Patient shape the original turbopuffer-backed app used; writes are plain inserts and
// updates (the app's database role can't delete).
import "server-only";
import { cache } from "react";
import { randomUUID } from "node:crypto";
import { db, timed, type QueryTiming } from "./db";
import type { Condition, Medication, Observation, Patient, PatientRecord } from "./types";

// One row per patient: the patient, their active primary condition and their latest result per biomarker.
// Biomarkers read like the original app's text field: "HER2+, ER-, PD-L1 50%".
const PATIENT_ROWS = `
  select p.id, p.name, p.date_of_birth, extract(year from age(p.date_of_birth))::int as age, p.sex, p.city, p.state,
         p.specialty, p.ecog,
         coalesce(c.description, '') as primary_dx, coalesce(c.stage, '') as stage,
         coalesce((
           select string_agg(case b.result when 'positive' then b.name || '+' when 'negative' then b.name || '-'
                                           else b.name || ' ' || b.result end, ', ' order by b.name)
           from (select distinct on (name) name, result from observations
                 where patient_id = p.id and kind = 'biomarker' order by name, observed_on desc, id desc) b
         ), '') as biomarkers
  from patients p
  left join conditions c on c.patient_id = p.id and c.is_primary and c.status = 'active'`;

async function loadPatients(): Promise<Patient[]> {
  const rows = await timed("list-patients", () => db().unsafe(`${PATIENT_ROWS} order by p.name`));
  return rows as unknown as Patient[];
}

/** All patients, once per request (the layout and the page share it). */
export const getPatients = cache(loadPatients);

export async function getPatient(id: string | undefined | null): Promise<Patient | null> {
  if (!id) return null;
  return (await getPatients()).find((p) => p.id === id) ?? null;
}

/** A patient read fresh, bypassing the per-request cache: after an edit, and for the copilot's record tool. */
async function readPatient(id: string, log?: QueryTiming[]): Promise<Patient | null> {
  const rows = await timed("read-patient", () => db().unsafe(`${PATIENT_ROWS} where p.id = $1`, [id]), log);
  return (rows[0] as unknown as Patient) ?? null;
}

/**
 * The structured record: every condition, every medication (current first), and the latest result of each lab and
 * biomarker. Four queries, run in parallel.
 */
export async function getRecord(id: string): Promise<PatientRecord | null> {
  const sql = db();
  const queries: QueryTiming[] = [];
  const [patient, conditions, medications, latest] = await Promise.all([
    readPatient(id, queries),
    timed("conditions", () => sql<Condition[]>`
      select id::int, description, icd10_code, stage, is_primary, status, diagnosed_on from conditions
      where patient_id = ${id} order by status, is_primary desc, diagnosed_on desc nulls last`, queries),
    timed("medications", () => sql<Medication[]>`
      select id::int, name, drug_class, dose, started_on, stopped_on from medications
      where patient_id = ${id} order by stopped_on is not null, coalesce(stopped_on, started_on) desc nulls last, name`, queries),
    timed("latest-observations", () => sql<Observation[]>`
      select distinct on (kind, name) id::int, kind, name, value::float8 as value, unit, result, observed_on
      from observations where patient_id = ${id} order by kind, name, observed_on desc, id desc`, queries),
  ]);
  if (!patient) return null;
  return { patient, conditions: [...conditions], medications: [...medications], latest: [...latest], queries };
}

/** Every result for one lab or biomarker, oldest first. Matches the name loosely ("egfr" finds "eGFR"). */
export async function labHistory(id: string, name: string): Promise<{ rows: Observation[]; ms: number }> {
  const log: QueryTiming[] = [];
  const rows = await timed("lab-history", () => db()<Observation[]>`
    select id::int, kind, name, value::float8 as value, unit, result, observed_on from observations
    where patient_id = ${id} and lower(name) like ${`%${name.trim().toLowerCase()}%`}
    order by name, observed_on, id`, log);
  return { rows: [...rows], ms: log[0]?.ms ?? 0 };
}

// ------------------------------------------------------------------ notes

// Notes live in turbopuffer (each patient's ts-patient-<id> namespace), not here; see lib/notes.ts.
export { listNotes, noteAuthor, saveNote } from "./notes";

// ------------------------------------------------------------------ editing the record

export interface NewPatient {
  name: string; date_of_birth: string; sex: string; city: string; state: string;
  specialty: "Oncology" | "Cardiology"; ecog: number | null;
  diagnosis: string; stage: string; icd10_code: string | null; diagnosed_on: string | null;
}

/** A new patient and their primary diagnosis, in one transaction: either both rows exist or neither does. */
export async function createPatient(p: NewPatient): Promise<Patient> {
  const id = `pt-${randomUUID().slice(0, 8)}`;
  await timed("create-patient", () => db().begin(async (tx) => {
    await tx`insert into patients (id, name, date_of_birth, sex, city, state, specialty, ecog)
      values (${id}, ${p.name}, ${p.date_of_birth}, ${p.sex}, ${p.city}, ${p.state}, ${p.specialty}, ${p.ecog})`;
    await tx`insert into conditions (patient_id, description, icd10_code, stage, is_primary, diagnosed_on)
      values (${id}, ${p.diagnosis}, ${p.icd10_code}, ${p.stage}, true, ${p.diagnosed_on})`;
    return [];
  }));
  return (await readPatient(id))!;
}

/** One change to a patient's record, as the record panel sends it. */
export type RecordChange =
  | { op: "update-patient"; fields: Partial<Pick<Patient, "name" | "date_of_birth" | "sex" | "city" | "state" | "ecog">> }
  | { op: "add-condition"; description: string; stage: string; icd10_code: string | null; diagnosed_on: string | null }
  | { op: "update-condition"; id: number; stage?: string; status?: "active" | "resolved" }
  | { op: "add-medication"; name: string; drug_class: string; dose: string; started_on: string | null }
  | { op: "stop-medication"; id: number; stopped_on: string }
  | { op: "add-observation"; kind: "lab" | "biomarker"; name: string; value: number | null; unit: string; result: string; observed_on: string };

const PATIENT_FIELDS = ["name", "date_of_birth", "sex", "city", "state", "ecog"] as const;

/** Apply one change and return the record as it now stands. Constraint violations come back as the database's message. */
export async function changeRecord(patientId: string, c: RecordChange): Promise<{ record: PatientRecord; ms: number }> {
  const sql = db();
  const t0 = performance.now();
  switch (c.op) {
    case "update-patient": {
      const fields = Object.fromEntries(PATIENT_FIELDS.filter((k) => k in c.fields).map((k) => [k, c.fields[k] ?? null]));
      if (!Object.keys(fields).length) break;
      await timed("update-patient", () => sql`
        update patients set ${sql(fields)}, updated_at = now() where id = ${patientId}`);
      break;
    }
    case "add-condition":
      await timed("add-condition", () => sql`
        insert into conditions (patient_id, description, icd10_code, stage, diagnosed_on)
        values (${patientId}, ${c.description}, ${c.icd10_code}, ${c.stage}, ${c.diagnosed_on})`);
      break;
    case "update-condition": {
      const fields: Record<string, string> = {};
      if (c.stage !== undefined) fields.stage = c.stage;
      if (c.status) fields.status = c.status;
      if (!Object.keys(fields).length) break;
      await timed("update-condition", () => sql`
        update conditions set ${sql(fields)}, updated_at = now() where id = ${c.id} and patient_id = ${patientId}`);
      break;
    }
    case "add-medication":
      await timed("add-medication", () => sql`
        insert into medications (patient_id, name, drug_class, dose, started_on)
        values (${patientId}, ${c.name}, ${c.drug_class}, ${c.dose}, ${c.started_on})`);
      break;
    case "stop-medication":
      await timed("stop-medication", () => sql`
        update medications set stopped_on = ${c.stopped_on} where id = ${c.id} and patient_id = ${patientId}`);
      break;
    case "add-observation":
      await timed("add-observation", () => sql`
        insert into observations (patient_id, kind, name, value, unit, result, observed_on)
        values (${patientId}, ${c.kind}, ${c.name}, ${c.kind === "lab" ? c.value : null}, ${c.kind === "lab" ? c.unit : ""},
          ${c.kind === "biomarker" ? c.result : ""}, ${c.observed_on})`);
      break;
  }
  const ms = performance.now() - t0;
  const record = await getRecord(patientId);
  if (!record) throw new Error("Unknown patient.");
  return { record, ms };
}

// ------------------------------------------------------------------ record as text, for Claude

/**
 * The record as tagged lines, for the copilot and the eligibility check: [R1], [R2]… so a verdict can cite the exact
 * row it relied on ("eGFR 42 mL/min/1.73m² on 2026-10-02 [R7]").
 */
export function recordLines(r: PatientRecord): { tag: string; text: string }[] {
  const p = r.patient;
  const lines: string[] = [
    `Patient: ${p.name}, ${p.age}-year-old ${p.sex.toLowerCase()} (born ${p.date_of_birth}), ${p.city}, ${p.state}; specialty ${p.specialty}` +
      (p.ecog != null ? `; ECOG ${p.ecog}` : ""),
    ...r.conditions.map((c) => `Condition (${c.status}${c.is_primary ? ", primary" : ""}): ${c.description}` +
      (c.stage ? `, stage ${c.stage}` : "") + (c.icd10_code ? ` [ICD-10 ${c.icd10_code}]` : "") +
      (c.diagnosed_on ? `, diagnosed ${c.diagnosed_on}` : "")),
    ...r.medications.map((m) => `Medication (${m.stopped_on ? `stopped ${m.stopped_on}` : "current"}): ${m.name}` +
      (m.dose ? ` ${m.dose}` : "") + (m.drug_class ? ` (${m.drug_class})` : "") + (m.started_on ? `, started ${m.started_on}` : "")),
    ...r.latest.map((o) => o.kind === "lab"
      ? `Lab (latest): ${o.name} ${o.value} ${o.unit} on ${o.observed_on}`
      : `Biomarker (latest): ${o.name} ${o.result} on ${o.observed_on}`),
  ];
  return lines.map((text, i) => ({ tag: `R${i + 1}`, text }));
}
