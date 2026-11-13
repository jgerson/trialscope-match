// Search across all patients, at the top of the patient workspace. Three modes:
//
// - attributes: one SQL query over the structured record in Supabase (diagnosis, biomarkers, medications, latest labs,
//   age, sex, ECOG). Every filter returns the row that satisfied it, so each match shows its evidence.
// - notes: one hybrid search (BM25 + vector) over every note in turbopuffer's match-notes, grouped by patient.
// - both: the attribute filters pick the patients in Postgres, then the notes search runs over only those patients
//   (a patient_id In [...] filter in turbopuffer). Each store does the part it's good at: exact facts, then wording.
import "server-only";
import type postgres from "postgres";
import { NS } from "./config";
import { db } from "./db";
import { getPatients } from "./patients";
import { search } from "./tpuf";
import type { Hit, Patient, SearchResponse } from "./types";

export type AttrFilter =
  | { kind: "diagnosis"; text: string }
  | { kind: "biomarker"; text: string }
  | { kind: "medication"; text: string; when: "current" | "ever" | "never" }
  | { kind: "lab"; name: string; op: ">=" | "<="; value: number }
  | { kind: "age"; min?: number; max?: number }
  | { kind: "sex"; value: "Female" | "Male" }
  | { kind: "ecog"; max: number };

export type SearchMode = "notes" | "attributes" | "both";

export interface PatientMatch {
  patient: Pick<Patient, "id" | "name" | "age" | "sex" | "primary_dx" | "stage" | "specialty">;
  /** One line per attribute filter: what in the record satisfied it. */
  evidence: { filter: string; text: string }[];
  /** The patient's notes that matched the text, best first (notes and both modes). */
  notes: Hit[];
}

export interface PatientSearchResult {
  mode: SearchMode;
  patients: PatientMatch[];
  supabase?: { ms: number; matched: number; sql: string };
  turbopuffer?: { ms: number; notesReturned: number; filteredTo: number | null; search: SearchResponse };
}

const MAX_FILTERS = 8;
const NOTES_TOP_K = 50;
const NOTES_PER_PATIENT = 3;

/** A short label for a filter, as the chip and the evidence line show it. */
export function filterLabel(f: AttrFilter): string {
  switch (f.kind) {
    case "diagnosis": return `Diagnosis contains “${f.text}”`;
    case "biomarker": return `Biomarker “${f.text}”`;
    case "medication": return `${f.when === "current" ? "On" : f.when === "ever" ? "Ever on" : "Not on"} “${f.text}”`;
    case "lab": return `Latest ${f.name} ${f.op === ">=" ? "≥" : "≤"} ${f.value}`;
    case "age": return f.min != null && f.max != null ? `Age ${f.min}–${f.max}` : f.min != null ? `Age ≥ ${f.min}` : `Age ≤ ${f.max}`;
    case "sex": return `Sex ${f.value.toLowerCase()}`;
    case "ecog": return `ECOG ≤ ${f.max}`;
  }
}

/** Validate filters from the browser; anything malformed is dropped. */
export function cleanFilters(raw: unknown): AttrFilter[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const out: AttrFilter[] = [];
  for (const r of raw.slice(0, MAX_FILTERS) as Record<string, unknown>[]) {
    const k = r?.kind;
    if ((k === "diagnosis" || k === "biomarker") && str(r.text)) out.push({ kind: k, text: str(r.text) });
    else if (k === "medication" && str(r.text) && ["current", "ever", "never"].includes(String(r.when)))
      out.push({ kind: k, text: str(r.text), when: r.when as "current" | "ever" | "never" });
    else if (k === "lab" && str(r.name) && (r.op === ">=" || r.op === "<=") && num(r.value) != null)
      out.push({ kind: k, name: str(r.name), op: r.op, value: num(r.value)! });
    else if (k === "age" && (num(r.min) != null || num(r.max) != null)) out.push({ kind: k, min: num(r.min), max: num(r.max) });
    else if (k === "sex" && (r.value === "Female" || r.value === "Male")) out.push({ kind: k, value: r.value });
    else if (k === "ecog" && num(r.max) != null) out.push({ kind: k, max: Math.round(num(r.max)!) });
  }
  return out;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * For one filter, a scalar subquery that returns the record text satisfying it for patient p, or null when it isn't
 * satisfied. Used both as the evidence column and, with "is not null", as the WHERE condition.
 */
function evidence(sql: postgres.Sql, f: AttrFilter): postgres.PendingQuery<postgres.Row[]> {
  switch (f.kind) {
    case "diagnosis":
      return sql`(select string_agg(c.description || case when c.stage <> '' then ' (stage ' || c.stage || ')' else '' end, '; ')
        from conditions c where c.patient_id = p.id and c.status = 'active' and c.description ilike ${like(f.text)})`;
    case "biomarker":
      // The latest result for each biomarker, matched on its name and result together ("ALK", "V600E", "HER2 3").
      return sql`(select string_agg(b.name || ' ' || b.result || ' (' || b.observed_on::text || ')', '; ')
        from (select distinct on (name) name, result, observed_on from observations
              where patient_id = p.id and kind = 'biomarker' order by name, observed_on desc, id desc) b
        where (b.name || ' ' || b.result) ilike ${like(f.text)})`;
    case "medication": {
      const match = sql`(m.name ilike ${like(f.text)} or m.drug_class ilike ${like(f.text)})`;
      if (f.when === "never") {
        return sql`(select case when count(*) = 0 then 'no ' || ${f.text} || ' on record' end
          from medications m where m.patient_id = p.id and ${match})`;
      }
      return sql`(select string_agg(m.name || ' (' || m.drug_class || ')' ||
          case when m.stopped_on is null then ', current' else ', stopped ' || m.stopped_on::text end, '; ')
        from medications m where m.patient_id = p.id and ${match} ${f.when === "current" ? sql`and m.stopped_on is null` : sql``})`;
    }
    case "lab":
      return sql`(select string_agg(o.name || ' ' || o.value::text || ' ' || o.unit || ' (' || o.observed_on::text || ')', '; ')
        from (select distinct on (name) name, value::float8 as value, unit, observed_on from observations
              where patient_id = p.id and kind = 'lab' and lower(name) = lower(${f.name}) order by name, observed_on desc, id desc) o
        where ${f.op === ">=" ? sql`o.value >= ${f.value}` : sql`o.value <= ${f.value}`})`;
    case "age": {
      const age = sql`extract(year from age(p.date_of_birth))::int`;
      return sql`(case when ${age} >= ${f.min ?? 0} and ${age} <= ${f.max ?? 200} then 'age ' || ${age}::text end)`;
    }
    case "sex":
      return sql`(case when p.sex = ${f.value} then p.sex end)`;
    case "ecog":
      return sql`(case when p.ecog <= ${f.max} then 'ECOG ' || p.ecog::text end)`;
  }
}

/** Patients matching every filter, with the evidence for each. */
async function byAttributes(filters: AttrFilter[]): Promise<{ ids: string[]; evidence: Map<string, string[]>; ms: number; sql: string }> {
  const sql = db();
  const cols = filters.map((f, i) => sql`, ${evidence(sql, f)} as ${sql(`e${i}`)}`);
  const select = cols.reduce((acc, c) => sql`${acc}${c}`, sql`select p.id`);
  const where = filters.map((_, i) => sql`${sql(`e${i}`)} is not null`)
    .reduce((acc, c, i) => (i === 0 ? sql`where ${c}` : sql`${acc} and ${c}`), sql``);
  const t0 = performance.now();
  const rows = await sql`select * from (${select} from patients p) t ${where} order by id`;
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  console.log(JSON.stringify({ postgres: "patient-search", ms, rows: rows.length, filters: filters.map((f) => f.kind) }));
  const byId = new Map(rows.map((r) => [String(r.id), filters.map((_, i) => String(r[`e${i}`]))]));
  const text = (rows as unknown as { statement?: { string?: string } }).statement?.string ?? "";
  return { ids: rows.map((r) => String(r.id)), evidence: byId, ms, sql: text.replace(/\s+/g, " ").trim() };
}

const brief = (p: Patient): PatientMatch["patient"] =>
  ({ id: p.id, name: p.name, age: p.age, sex: p.sex, primary_dx: p.primary_dx, stage: p.stage, specialty: p.specialty });

export async function searchPatients(mode: SearchMode, text: string, filters: AttrFilter[]): Promise<PatientSearchResult> {
  const patients = new Map((await getPatients()).map((p) => [p.id, p]));
  const out: PatientSearchResult = { mode, patients: [] };

  let ids: string[] | null = null;
  let ev = new Map<string, string[]>();
  if (mode !== "notes" && filters.length) {
    const a = await byAttributes(filters);
    ids = a.ids;
    ev = a.evidence;
    out.supabase = { ms: a.ms, matched: a.ids.length, sql: a.sql };
  }
  const evidenceOf = (id: string) => filters.length && ev.has(id)
    ? filters.map((f, i) => ({ filter: filterLabel(f), text: ev.get(id)![i] })) : [];

  // Attributes only, or both with no text: the SQL result is the answer.
  if (mode === "attributes" || !text.trim()) {
    out.patients = (ids ?? []).flatMap((id) => (patients.has(id) ? [{ patient: brief(patients.get(id)!), evidence: evidenceOf(id), notes: [] }] : []))
      .sort((a, b) => a.patient.name.localeCompare(b.patient.name));
    return out;
  }
  if (ids && !ids.length) return out; // no patient passed the filters, so there is nothing to search

  const filter = ids ? ["patient_id", "In", ids] : null;
  const res = await search([{ namespace: NS.notes, filter }], text, "hybrid", NOTES_TOP_K);
  // Group by patient in rank order: a patient ranks by their best note.
  const groups = new Map<string, Hit[]>();
  for (const h of res.hits) {
    const pid = String(h.raw.patient_id ?? "");
    if (!patients.has(pid)) continue;
    const list = groups.get(pid) ?? [];
    if (list.length < NOTES_PER_PATIENT) list.push({ ...h, raw: {} });
    groups.set(pid, list);
  }
  out.patients = [...groups.entries()].map(([pid, notes]) => ({ patient: brief(patients.get(pid)!), evidence: evidenceOf(pid), notes }));
  out.turbopuffer = {
    ms: Math.round(res.wallMs), notesReturned: res.hits.length, filteredTo: ids ? ids.length : null,
    search: { ...res, hits: res.hits.map((h) => ({ ...h, raw: {} })), runs: res.runs.map((r) => ({ ...r })) },
  };
  return out;
}

/** Suggestions for the filter inputs: the values that exist in the data. */
export async function filterOptions(): Promise<{ diagnoses: string[]; biomarkers: string[]; medications: string[]; labs: string[] }> {
  const sql = db();
  const [dx, bm, meds, labs] = await Promise.all([
    sql`select distinct description as v from conditions order by 1`,
    sql`select distinct name as v from observations where kind = 'biomarker' order by 1`,
    sql`select v from (select distinct drug_class as v from medications union select distinct name from medications) t order by 1`,
    sql`select distinct name as v from observations where kind = 'lab' order by 1`,
  ]);
  const vals = (rows: postgres.Row[]) => rows.map((r) => String(r.v));
  return { diagnoses: vals(dx), biomarkers: vals(bm), medications: vals(meds), labs: vals(labs) };
}
