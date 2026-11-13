// "Find patients for this trial": which of the clinic's patients could fit a trial, from their structured record.
//
// 1. Criteria → rules (one model call per trial, cached in Supabase's trial_rules). The model turns the free-text
//    inclusion and exclusion criteria into rules the record can check: diagnosis, stage, biomarker, current, prior or
//    excluded medication, lab threshold, ECOG, excluded condition. Anything else is listed as "not checkable". Age and
//    sex come from the trial's structured fields, not the model.
// 2. Rules → SQL (no model): one query scores every patient on every rule as met, failed or unknown, with the record
//    row behind each verdict. Each rule is one LEFT JOIN LATERAL subquery returning (status, evidence).
//
// Exclusion criteria become what the patient must satisfy ("no prior lorlatinib" → never on lorlatinib), so every rule
// reads the same way: met is good, failed rules the patient out, unknown means the record doesn't say.
import "server-only";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type postgres from "postgres";
import { config } from "./config";
import { copilotClient } from "./copilot";
import type { Trial } from "./ctgov";
import { db } from "./db";
import { tracedCreate } from "./langfuse";
import { getPatients } from "./patients";
import type { Patient } from "./types";

export type RuleStatus = "met" | "failed" | "unknown";

export type Rule = { section: "inclusion" | "exclusion"; criterion: string } & (
  | { kind: "diagnosis"; any: string[] }
  | { kind: "specialty"; value: "Oncology" | "Cardiology" }
  | { kind: "stage"; any: string[] }
  | { kind: "biomarker"; name: string; result?: string }
  | { kind: "medication"; text: string; when: "current" | "ever" | "never" }
  | { kind: "lab"; name: string; op: ">=" | "<="; value: number }
  | { kind: "ecog"; max: number }
  | { kind: "no_condition"; text: string }
  | { kind: "age"; min?: number; max?: number }
  | { kind: "sex"; value: "Female" | "Male" }
);

export interface TrialRules {
  nct: string; rules: Rule[]; notCheckable: string[]; model: string; cached: boolean;
  ms: number; inTokens: number | null; outTokens: number | null;
}

export interface Candidate {
  patient: Pick<Patient, "id" | "name" | "age" | "sex" | "primary_dx" | "stage">;
  results: { status: RuleStatus; evidence: string | null }[]; // one per rule, in rule order
  met: number; failed: number; unknown: number;
}

export interface TrialMatch {
  rules: TrialRules;
  candidates: Candidate[]; // no failed rules, best first
  excluded: Candidate[];   // at least one failed rule
  sql: { ms: number; statement: string };
}

const VERSION = 2; // bump when the prompt or the rule shapes change, so cached rules are extracted again
const MAX_RULES = 16;

/** A short label for a rule, as its chip shows it. */
export function ruleLabel(r: Rule): string {
  switch (r.kind) {
    case "diagnosis": return r.any.join(" or ");
    case "specialty": return r.value === "Oncology" ? "Any cancer" : "Any heart condition";
    case "stage": return `Stage ${r.any.join("/")}`;
    case "biomarker": return r.result ? `${r.name} ${r.result}` : `${r.name} result`;
    case "medication": return `${r.when === "current" ? "On" : r.when === "ever" ? "Prior" : "No"} ${r.text}`;
    case "lab": return `${r.name} ${r.op === ">=" ? "≥" : "≤"} ${r.value}`;
    case "ecog": return `ECOG ≤ ${r.max}`;
    case "no_condition": return `No ${r.text}`;
    case "age": return r.min != null && r.max != null ? `Age ${r.min}–${r.max}` : r.min != null ? `Age ≥ ${r.min}` : `Age ≤ ${r.max}`;
    case "sex": return r.value;
  }
}

// ------------------------------------------------------------------ 1. criteria → rules

/** "18 Years", "6 Months", "None" → years, or undefined. */
function years(s: string): number | undefined {
  const m = s.match(/(\d+(?:\.\d+)?)\s*(year|month|week|day)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const per = { year: 1, month: 12, week: 52, day: 365 }[m[2].toLowerCase() as "year"];
  return Math.floor(n / per);
}

/** Age and sex rules from the trial's structured fields. */
function structuralRules(t: Trial): Rule[] {
  const out: Rule[] = [];
  const min = years(t.minAge), max = years(t.maxAge);
  if (min != null || max != null) out.push({ kind: "age", min, max, section: "inclusion", criterion: `Ages ${t.minAge} to ${t.maxAge}` });
  if (t.sex === "Female" || t.sex === "Male") out.push({ kind: "sex", value: t.sex, section: "inclusion", criterion: `Sex: ${t.sex}` });
  return out;
}

const SYSTEM = (vocab: string) => `You turn a clinical trial's eligibility criteria into rules that a clinic's structured \
patient records can check, so the clinic can list which of its patients might fit. All patients are synthetic demo records.

Each patient record has: active conditions with stage (Roman numerals, like IIIB or IV); biomarkers, each a name and \
a result; medications by name and drug class, current or stopped; lab results by name with values; ECOG.
${vocab}

Rule kinds (report through the tool):
- specialty: "Oncology" (any cancer) or "Cardiology" (any heart condition). Use it when the trial accepts any cancer, \
or any heart condition, rather than a named one; every patient record belongs to exactly one specialty.
- diagnosis: the patient has an active condition whose name contains any of these words, e.g. ["non-small cell lung"].
- stage: the primary diagnosis's stage starts with any of these Roman numerals, e.g. ["III", "IV"].
- biomarker: the patient's latest result for this biomarker name contains this result text, e.g. name "ALK", result \
"rearrangement"; name "BRAF", result "V600E". Leave result empty when any result for the marker qualifies.
- medication: by drug name or drug class. when "current" (on it now), "ever" (on it now or before, e.g. "progressed on"), \
or "never" (an exclusion like "no prior lorlatinib").
- lab: the latest value of this lab compared with a threshold, in the record's unit. Convert units if needed; if you \
can't, make it not checkable.
- ecog: maximum ECOG performance status.
- no_condition: the patient must not have an active condition containing this text (e.g. "kidney disease").

Rules:
- Use only names that appear in the record vocabulary above where one fits; plain words otherwise.
- Every trial needs a disease rule: a diagnosis rule for a named disease, or a specialty rule when any cancer (or any \
heart condition) qualifies. If the criteria text doesn't name the disease, take it from the trial's listed conditions.
- Write exclusion criteria as what the patient must satisfy, with section "exclusion": "prior lorlatinib" becomes \
medication never lorlatinib.
- Only make a rule when the criterion clearly maps to one kind. Everything else (consent, life expectancy, ability to \
swallow, organ function without a number, washout periods, pregnancy, measurable disease, brain metastases unless \
listed as a condition) goes in not_checkable as a short phrase.
- Skip age and sex: they are checked separately.
- At most ${MAX_RULES} rules, most decisive first. criterion is the source criterion in at most 15 words.`;

const TOOL: Anthropic.Tool = {
  name: "report_rules",
  description: "Report the checkable rules and the criteria that can't be checked from the record.",
  input_schema: {
    type: "object",
    properties: {
      rules: {
        type: "array", maxItems: MAX_RULES,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["specialty", "diagnosis", "stage", "biomarker", "medication", "lab", "ecog", "no_condition"] },
            section: { type: "string", enum: ["inclusion", "exclusion"] },
            criterion: { type: "string" },
            any: { type: "array", items: { type: "string" }, description: "diagnosis words or stage numerals" },
            name: { type: "string", description: "biomarker or lab name" },
            result: { type: "string", description: "biomarker result text" },
            text: { type: "string", description: "medication name or class, or excluded condition" },
            when: { type: "string", enum: ["current", "ever", "never"] },
            op: { type: "string", enum: [">=", "<="] },
            value: { type: "number" },
            max: { type: "number" },
            specialty: { type: "string", enum: ["Oncology", "Cardiology"] },
          },
          required: ["kind", "section", "criterion"],
        },
      },
      not_checkable: { type: "array", items: { type: "string" } },
    },
    required: ["rules", "not_checkable"],
  },
};

/**
 * Keep only well-formed rules, from the model's output or from the cache (rows in trial_rules are re-checked on every
 * read, so a bad or edited row can't change who is listed).
 *
 * Every rule must read as something the patient must satisfy. An exclusion the model wrote the inclusion way round is
 * flipped where it can be (an excluded diagnosis becomes "no condition", an excluded current or prior drug becomes
 * "never on") and dropped where it can't (an excluded stage, specialty or biomarker has no "must not" form here).
 */
function cleanRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return [];
  const s = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");
  const out: Rule[] = [];
  for (const r of raw.slice(0, MAX_RULES) as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const exclusion = r.section === "exclusion";
    const base = { section: exclusion ? "exclusion" as const : "inclusion" as const, criterion: s(r.criterion) || "From the criteria" };
    const any = Array.isArray(r.any) ? (r.any as unknown[]).map(s).filter(Boolean).slice(0, 6) : [];
    const specialty = r.specialty ?? r.value; // the model sends `specialty`; cached rules store `value`
    if (exclusion && ["specialty", "stage", "biomarker"].includes(String(r.kind))) continue;
    if (exclusion && r.kind === "diagnosis") {
      for (const text of any) out.push({ ...base, kind: "no_condition", text });
      continue;
    }
    if (r.kind === "specialty" && (specialty === "Oncology" || specialty === "Cardiology"))
      out.push({ ...base, kind: "specialty", value: specialty });
    else if (r.kind === "diagnosis" && any.length) out.push({ ...base, kind: "diagnosis", any });
    else if (r.kind === "stage" && any.length) {
      const stages = [...new Set(any.map((x) => x.toUpperCase().match(/^(IV|III|II|I)/)?.[1]).filter(Boolean) as string[])];
      if (stages.length) out.push({ ...base, kind: "stage", any: stages });
    } else if (r.kind === "biomarker" && s(r.name)) out.push({ ...base, kind: "biomarker", name: s(r.name), ...(s(r.result) ? { result: s(r.result) } : {}) });
    else if (r.kind === "medication" && s(r.text) && ["current", "ever", "never"].includes(String(r.when)))
      out.push({ ...base, kind: "medication", text: s(r.text), when: exclusion ? "never" : (r.when as "current") });
    else if (r.kind === "lab" && s(r.name) && (r.op === ">=" || r.op === "<=") && typeof r.value === "number" && Number.isFinite(r.value))
      out.push({ ...base, kind: "lab", name: s(r.name), op: r.op, value: r.value });
    else if (r.kind === "ecog" && typeof r.max === "number" && r.max >= 0 && r.max <= 5) out.push({ ...base, kind: "ecog", max: Math.round(r.max) });
    else if (r.kind === "no_condition" && s(r.text)) out.push({ ...base, kind: "no_condition", text: s(r.text) });
  }
  return out;
}

async function vocabulary(): Promise<string> {
  const sql = db();
  const [labs, classes, markers] = await Promise.all([
    sql`select name, min(unit) as unit from observations where kind = 'lab' group by name order by name`,
    sql`select distinct drug_class as v from medications order by 1`,
    sql`select distinct name as v from observations where kind = 'biomarker' order by 1`,
  ]);
  return `Record vocabulary. Labs (name, unit): ${labs.map((l) => `${l.name} (${l.unit})`).join(", ")}. ` +
    `Drug classes: ${classes.map((c) => c.v).join(", ")}. Biomarker names: ${markers.map((m) => m.v).join(", ")}.`;
}

/** The trial's rules: from the cache when the criteria haven't changed, otherwise from one model call. */
export async function getRules(trial: Trial): Promise<TrialRules> {
  const t0 = performance.now();
  const hash = createHash("sha256")
    .update(JSON.stringify([VERSION, trial.criteria, trial.conditions, trial.minAge, trial.maxAge, trial.sex])).digest("hex");
  const sql = db();
  const [hit] = await sql<{ rules: Rule[]; not_checkable: string[]; model: string; in_tokens: number | null; out_tokens: number | null }[]>`
    select rules, not_checkable, model, in_tokens, out_tokens from trial_rules where nct = ${trial.nct} and criteria_hash = ${hash}`;
  if (hit) {
    const notCheckable = Array.isArray(hit.not_checkable) ? hit.not_checkable.map((x) => String(x).slice(0, 120)).slice(0, 20) : [];
    return { nct: trial.nct, rules: [...structuralRules(trial), ...cleanRules(hit.rules)], notCheckable, model: String(hit.model),
      cached: true, ms: Math.round(performance.now() - t0), inTokens: hit.in_tokens, outTokens: hit.out_tokens };
  }
  if (!trial.criteria.trim()) {
    return { nct: trial.nct, rules: structuralRules(trial), notCheckable: [], model: "none", cached: false, ms: 0, inTokens: null, outTokens: null };
  }
  const llm = await copilotClient();
  const msg = await tracedCreate("extract-trial-rules", llm, {
    model: config.copilotModel,
    max_tokens: 4000,
    system: SYSTEM(await vocabulary()),
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: `<trial id="${trial.nct}">\n${trial.title}\n` +
      `Listed conditions: ${trial.conditions.join("; ") || "none"}\n\n${trial.criteria}\n</trial>` }],
  }, { nct: trial.nct });
  const call = msg.content.find((b) => b.type === "tool_use");
  // A missing or cut-off answer isn't "no rules": report it and cache nothing, so the next view tries again.
  if (call?.type !== "tool_use" || msg.stop_reason === "max_tokens") {
    throw new Error(msg.stop_reason === "max_tokens"
      ? "The model's answer was cut off before it finished the rules. Reload to try again."
      : "The model didn't return any rules. Reload to try again.");
  }
  const input = call.input as { rules?: unknown; not_checkable?: unknown };
  const rules = cleanRules(input.rules);
  const notCheckable = Array.isArray(input.not_checkable)
    ? (input.not_checkable as unknown[]).map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 20) : [];
  await sql`
    insert into trial_rules (nct, criteria_hash, rules, not_checkable, model, in_tokens, out_tokens)
    values (${trial.nct}, ${hash}, ${sql.json(rules)}, ${sql.json(notCheckable)}, ${config.copilotModel},
            ${msg.usage.input_tokens}, ${msg.usage.output_tokens})
    on conflict (nct) do update set criteria_hash = excluded.criteria_hash, rules = excluded.rules,
      not_checkable = excluded.not_checkable, model = excluded.model, in_tokens = excluded.in_tokens,
      out_tokens = excluded.out_tokens, updated_at = now()`;
  return { nct: trial.nct, rules: [...structuralRules(trial), ...rules], notCheckable, model: config.copilotModel,
    cached: false, ms: Math.round(performance.now() - t0), inTokens: msg.usage.input_tokens, outTokens: msg.usage.output_tokens };
}

// ------------------------------------------------------------------ 2. rules → SQL

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** One rule as a lateral subquery over patient p, returning exactly one row: (status, evidence). */
function lateral(sql: postgres.Sql, r: Rule): postgres.PendingQuery<postgres.Row[]> {
  switch (r.kind) {
    case "diagnosis":
      return sql`select case when count(*) > 0 then 'met' else 'failed' end as status,
          coalesce(string_agg(c.description || case when c.stage <> '' then ' (stage ' || c.stage || ')' else '' end, '; '),
            (select description from conditions where patient_id = p.id and is_primary and status = 'active' limit 1)) as ev
        from conditions c where c.patient_id = p.id and c.status = 'active' and c.description ilike any(${r.any.map(like)}::text[])`;
    case "stage":
      // A stage that isn't a Roman numeral (NYHA II, Post-MI, Paroxysmal) says nothing about this rule: unknown.
      return sql`select case when substring(upper(coalesce(max(c.stage), '')) from '^(IV|III|II|I)') is null then 'unknown'
            when substring(upper(max(c.stage)) from '^(IV|III|II|I)') = any(${r.any}::text[]) then 'met' else 'failed' end as status,
          nullif('stage ' || coalesce(max(c.stage), ''), 'stage ') as ev
        from conditions c where c.patient_id = p.id and c.is_primary and c.status = 'active'`;
    case "biomarker": {
      const ok = r.result ? sql`(b.name || ' ' || b.result) ilike ${like(r.result)}` : sql`true`;
      return sql`select case when count(*) = 0 then 'unknown' when bool_or(${ok}) then 'met' else 'failed' end as status,
          string_agg(b.name || ' ' || b.result || ' (' || b.observed_on::text || ')', '; ') as ev
        from (select distinct on (name) name, result, observed_on from observations
              where patient_id = p.id and kind = 'biomarker' and name ilike ${like(r.name)}
              order by name, observed_on desc, id desc) b`;
    }
    case "medication": {
      const match = sql`m.patient_id = p.id and (m.name ilike ${like(r.text)} or m.drug_class ilike ${like(r.text)})`;
      const list = sql`string_agg(m.name || ' (' || m.drug_class || ')' ||
          case when m.stopped_on is null then ', current' else ', stopped ' || m.stopped_on::text end, '; ')`;
      if (r.when === "never") {
        return sql`select case when count(*) = 0 then 'met' else 'failed' end as status,
            coalesce(${list}, 'none on record') as ev from medications m where ${match}`;
      }
      return sql`select case when count(*) > 0 then 'met' else 'failed' end as status, ${list} as ev
        from medications m where ${match} ${r.when === "current" ? sql`and m.stopped_on is null` : sql``}`;
    }
    case "lab": {
      const ok = r.op === ">=" ? sql`o.value >= ${r.value}` : sql`o.value <= ${r.value}`;
      return sql`select case when count(*) = 0 then 'unknown' when bool_and(${ok}) then 'met' else 'failed' end as status,
          string_agg(o.name || ' ' || o.value::text || ' ' || o.unit || ' (' || o.observed_on::text || ')', '; ') as ev
        from (select distinct on (name) name, value::float8 as value, unit, observed_on from observations
              where patient_id = p.id and kind = 'lab' and lower(name) = lower(${r.name}) order by name, observed_on desc, id desc) o`;
    }
    case "ecog":
      return sql`select case when p.ecog is null then 'unknown' when p.ecog <= ${r.max} then 'met' else 'failed' end as status,
          'ECOG ' || p.ecog::text as ev`;
    case "no_condition":
      return sql`select case when count(*) = 0 then 'met' else 'failed' end as status, string_agg(c.description, '; ') as ev
        from conditions c where c.patient_id = p.id and c.status = 'active' and c.description ilike ${like(r.text)}`;
    case "specialty":
      return sql`select case when p.specialty = ${r.value} then 'met' else 'failed' end as status, p.specialty as ev`;
    case "age": {
      const age = sql`extract(year from age(p.date_of_birth))::int`;
      return sql`select case when ${age} >= ${r.min ?? 0} and ${age} <= ${r.max ?? 200} then 'met' else 'failed' end as status,
          'age ' || ${age}::text as ev`;
    }
    case "sex":
      return sql`select case when p.sex = ${r.value} then 'met' else 'failed' end as status, p.sex as ev`;
  }
}

/** Score every patient on every rule in one query. */
export async function matchPatients(trial: Trial): Promise<TrialMatch> {
  const rules = await getRules(trial);
  const sql = db();
  const patients = new Map((await getPatients()).map((p) => [p.id, p]));
  if (!rules.rules.length) return { rules, candidates: [], excluded: [], sql: { ms: 0, statement: "" } };

  const cols = rules.rules.map((_, i) => sql`, ${sql(`r${i}`)}.status as ${sql(`s${i}`)}, ${sql(`r${i}`)}.ev as ${sql(`e${i}`)}`)
    .reduce((acc, c) => sql`${acc}${c}`, sql`select p.id`);
  const joins = rules.rules.map((r, i) => sql` left join lateral (${lateral(sql, r)}) ${sql(`r${i}`)} on true`)
    .reduce((acc, j) => sql`${acc}${j}`, sql` from patients p`);
  const t0 = performance.now();
  const rows = await sql`${cols}${joins}`;
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  console.log(JSON.stringify({ postgres: "trial-match", nct: trial.nct, ms, rows: rows.length, rules: rules.rules.length }));

  const all: Candidate[] = rows.flatMap((row) => {
    const p = patients.get(String(row.id));
    if (!p) return [];
    const results = rules.rules.map((_, i) => ({
      status: (["met", "failed", "unknown"].includes(row[`s${i}`]) ? row[`s${i}`] : "unknown") as RuleStatus,
      evidence: row[`e${i}`] == null ? null : String(row[`e${i}`]),
    }));
    const n = (s: RuleStatus) => results.filter((x) => x.status === s).length;
    return [{ patient: { id: p.id, name: p.name, age: p.age, sex: p.sex, primary_dx: p.primary_dx, stage: p.stage },
      results, met: n("met"), failed: n("failed"), unknown: n("unknown") }];
  });
  const byFit = (a: Candidate, b: Candidate) => b.met - a.met || a.unknown - b.unknown || a.patient.name.localeCompare(b.patient.name);
  const text = (rows as unknown as { statement?: { string?: string } }).statement?.string ?? "";
  return {
    rules,
    candidates: all.filter((c) => !c.failed).sort(byFit),
    excluded: all.filter((c) => c.failed).sort((a, b) => a.failed - b.failed || byFit(a, b)),
    sql: { ms, statement: text },
  };
}
