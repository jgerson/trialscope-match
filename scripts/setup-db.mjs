#!/usr/bin/env node
// One-time setup for TrialScope Match's Supabase database.
//
//   node scripts/setup-db.mjs            create the tables (if missing), then load the patient records
//   node scripts/setup-db.mjs --check    only print row counts: turbopuffer namespaces and Supabase tables
//   node scripts/setup-db.mjs --rotate   also give the app's database role a new password
//
// Reads, never writes, the original app's ts-patients namespace for the patient list. Notes aren't loaded: they stay in
// each patient's ts-patient-{id} namespace, which the app reads and writes directly (lib/notes.ts). Namespace row
// counts are printed before and after, so you can see they didn't change. Medications, labs, extra conditions and dates of birth don't exist there, so they're generated here:
// deterministic per patient id (the same every run) and synthetic, like everything else in the demo.
//
// Environment (from `vercel env pull .env.local`, or set by hand):
//   POSTGRES_URL_NON_POOLING   Supabase admin connection (direct, port 5432); added by the Vercel Marketplace integration
//   POSTGRES_URL               Supabase pooled connection; used to print APP_DATABASE_URL for the app's role
//   TURBOPUFFER_API_KEY        the same key the app uses
//   TURBOPUFFER_REGION         optional, default aws-us-east-1
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import Turbopuffer from "@turbopuffer/turbopuffer";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(join(root, ".env.local"));

const ADMIN_URL = process.env.POSTGRES_URL_NON_POOLING || process.env.ADMIN_DATABASE_URL;
const TPUF_KEY = process.env.TURBOPUFFER_API_KEY;
if (!ADMIN_URL) fail("Set POSTGRES_URL_NON_POOLING (Supabase's direct admin connection string).");
if (!TPUF_KEY) fail("Set TURBOPUFFER_API_KEY.");

const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {}, ssl: process.env.PGSSL === "off" ? false : "require",
  types: { date: { to: 1082, from: [1082], serialize: (v) => v, parse: (v) => v } } });
const tp = new Turbopuffer({ apiKey: TPUF_KEY, region: process.env.TURBOPUFFER_REGION || "aws-us-east-1" });

const checkOnly = process.argv.includes("--check");

try {
  const patientsTp = await readAll("ts-patients", { include_attributes: true });
  const before = await tpufCounts(patientsTp.map((p) => String(p.id)));
  printCounts("turbopuffer, before", before);
  if (checkOnly) {
    printCounts("Supabase", await pgCounts());
    process.exit(0);
  }

  await migrate();
  await appRole();
  const [{ n }] = await sql`select count(*)::int as n from patients`;
  if (n > 0) {
    console.log(`\nSupabase already has ${n} patients; nothing loaded. (Delete the rows in the Supabase dashboard to load again.)`);
  } else {
    await load(patientsTp);
  }

  printCounts("Supabase", await pgCounts());
  const after = await tpufCounts(patientsTp.map((p) => String(p.id)));
  printCounts("turbopuffer, after", after);
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  console.log(changed.length ? `\nWARNING: turbopuffer counts changed for ${changed.join(", ")}` : "\nturbopuffer row counts unchanged.");
} finally {
  await sql.end();
}

// ------------------------------------------------------------------ schema

async function migrate() {
  const [{ exists }] = await sql`select to_regclass('public.patients') is not null as exists`;
  if (exists) { console.log("\nTables already exist; skipping the migration."); return; }
  const file = join(root, "supabase/migrations/0001_patient_record.sql");
  await sql.unsafe(readFileSync(file, "utf8"));
  console.log("\nCreated the tables, the trialscope_app role and its permissions.");
}

/**
 * Give the app's role a password and print the connection string to use as APP_DATABASE_URL: Supabase's pooled URL
 * (from POSTGRES_URL) with the user swapped for trialscope_app. Skipped when APP_DATABASE_URL is already set, unless
 * --rotate is passed.
 */
async function appRole() {
  if (process.env.APP_DATABASE_URL && !process.argv.includes("--rotate")) {
    console.log("APP_DATABASE_URL is already set; leaving the trialscope_app password alone (pass --rotate to change it).");
    return;
  }
  const pooled = process.env.POSTGRES_URL;
  if (!pooled) { console.log("POSTGRES_URL isn't set, so I can't build APP_DATABASE_URL; see the README."); return; }
  const password = randomBytes(24).toString("base64url");
  await sql.unsafe(`alter role trialscope_app with password '${password}'`);
  const url = new URL(pooled);
  const ref = decodeURIComponent(url.username).split(".")[1]; // pooler user names look like postgres.<project-ref>
  url.username = ref ? `trialscope_app.${ref}` : "trialscope_app";
  url.password = password;
  url.port = "6543"; // transaction mode
  url.search = "";
  console.log("\nSet a new password for trialscope_app. Add this to the Vercel project (all environments) and .env.local:");
  console.log(`\n  APP_DATABASE_URL=${url.toString()}\n`);
}

// ------------------------------------------------------------------ load

async function load(patientsTp) {
  const rows = { patients: [], conditions: [], medications: [], observations: [] };
  for (const p of patientsTp) {
    const id = String(p.id);
    const rnd = rng(id);
    const age = Number(p.age) || 60;
    const sex = /^f/i.test(String(p.sex)) ? "Female" : /^m/i.test(String(p.sex)) ? "Male" : fail(`Patient ${id}: sex "${p.sex}"`);
    const specialty = /cardio/i.test(String(p.specialty)) ? "Cardiology" : "Oncology";
    const dx = String(p.primary_dx || (specialty === "Oncology" ? "Cancer" : "Heart disease"));
    const markers = parseBiomarkers(String(p.biomarkers ?? ""));
    rows.patients.push({ id, name: String(p.name), date_of_birth: dob(age, rnd), sex, city: String(p.city ?? ""),
      state: String(p.state ?? ""), specialty, ecog: specialty === "Oncology" ? Math.floor(rnd() * 3) : null });
    rows.conditions.push({ patient_id: id, description: dx, icd10_code: icd10(dx), stage: String(p.stage ?? ""),
      is_primary: true, status: "active", diagnosed_on: daysAgo(600 + Math.floor(rnd() * 700)) });
    for (const c of comorbidities(specialty, rnd)) rows.conditions.push({ patient_id: id, ...c, is_primary: false, status: "active" });
    for (const m of medications(specialty, dx, markers, rnd)) rows.medications.push({ patient_id: id, ...m });
    for (const b of markers) rows.observations.push({ patient_id: id, kind: "biomarker", name: b.name, value: null, unit: "", result: b.result, observed_on: daysAgo(300 + Math.floor(rnd() * 200)) });
    for (const o of labs(specialty, dx, rows.conditions.filter((c) => c.patient_id === id), rnd)) rows.observations.push({ patient_id: id, kind: "lab", result: "", ...o });

    process.stdout.write(".");
  }
  console.log();

  // One transaction: either the whole demo dataset is loaded or none of it.
  await sql.begin(async (tx) => {
    for (const [table, list] of Object.entries(rows)) {
      for (let i = 0; i < list.length; i += 500) await tx`insert into ${tx(table)} ${tx(list.slice(i, i + 500))}`;
    }
  });
  console.log(`Loaded ${rows.patients.length} patients, ${rows.conditions.length} conditions, ${rows.medications.length} medications, ` +
    `and ${rows.observations.length} observations.`);
}

// ------------------------------------------------------------------ synthetic record

function parseBiomarkers(text) {
  return text.split(/[,;]/).map((t) => t.trim()).filter(Boolean).map((t) => {
    const sign = t.match(/^(.+?)\s*([+-]|positive|negative)$/i);
    if (sign) return { name: sign[1].trim(), result: /^(\+|positive)$/i.test(sign[2]) ? "positive" : "negative" };
    const [name, ...rest] = t.split(/\s+/);
    return { name, result: rest.join(" ") || "detected" };
  });
}

function has(markers, re, result) { return markers.some((m) => re.test(m.name) && (!result || m.result === result)); }

function medications(specialty, dx, markers, rnd) {
  const d = dx.toLowerCase();
  const start = () => daysAgo(30 + Math.floor(rnd() * 330));
  const meds = [];
  const add = (name, drug_class, dose) => meds.push({ name, drug_class, dose, started_on: start(), stopped_on: null });
  if (specialty === "Cardiology") {
    if (/heart failure|cardiomyopathy|hfref|hfpef/.test(d)) {
      add("sacubitril/valsartan", "ARNI", "49/51 mg twice daily");
      add("metoprolol succinate", "beta blocker", "50 mg daily");
      add("empagliflozin", "SGLT2 inhibitor", "10 mg daily");
      add("furosemide", "loop diuretic", "40 mg daily");
    } else if (/atrial fib|afib|flutter/.test(d)) {
      add("apixaban", "anticoagulant", "5 mg twice daily");
      add("metoprolol tartrate", "beta blocker", "25 mg twice daily");
    } else if (/coronary|cad|infarct|angina|stemi|nstemi/.test(d)) {
      add("aspirin", "antiplatelet", "81 mg daily");
      add("clopidogrel", "antiplatelet", "75 mg daily");
      add("atorvastatin", "statin", "80 mg daily");
    } else {
      add("lisinopril", "ACE inhibitor", "10 mg daily");
      add("atorvastatin", "statin", "40 mg daily");
    }
    if (rnd() < 0.25 && !meds.some((m) => m.drug_class === "anticoagulant")) add("warfarin", "anticoagulant", "dose per INR");
  } else {
    if (/breast/.test(d)) {
      if (has(markers, /her2/i, "positive")) { add("trastuzumab", "HER2-targeted antibody", "6 mg/kg every 3 weeks"); add("pertuzumab", "HER2-targeted antibody", "420 mg every 3 weeks"); }
      if (has(markers, /^(er|pr|hr)$/i, "positive")) add("letrozole", "aromatase inhibitor", "2.5 mg daily");
      if (rnd() < 0.5) meds.push({ name: "doxorubicin", drug_class: "anthracycline chemotherapy", dose: "60 mg/m² every 2 weeks", started_on: daysAgo(500), stopped_on: daysAgo(380) });
    } else if (/lung|nsclc/.test(d)) {
      if (has(markers, /egfr/i)) add("osimertinib", "EGFR tyrosine kinase inhibitor", "80 mg daily");
      else if (has(markers, /alk/i)) add("alectinib", "ALK inhibitor", "600 mg twice daily");
      else add("pembrolizumab", "PD-1 inhibitor", "200 mg every 3 weeks");
    } else if (/colo|rectal/.test(d)) {
      add("FOLFOX", "chemotherapy", "every 2 weeks"); add("bevacizumab", "VEGF inhibitor", "5 mg/kg every 2 weeks");
    } else if (/melanoma/.test(d)) {
      if (has(markers, /braf/i)) { add("dabrafenib", "BRAF inhibitor", "150 mg twice daily"); add("trametinib", "MEK inhibitor", "2 mg daily"); }
      else add("nivolumab", "PD-1 inhibitor", "480 mg every 4 weeks");
    } else if (/prostate/.test(d)) {
      add("enzalutamide", "androgen receptor inhibitor", "160 mg daily"); add("leuprolide", "GnRH agonist", "22.5 mg every 3 months");
    } else if (/lymphoma/.test(d)) {
      add("R-CHOP", "chemoimmunotherapy", "every 3 weeks");
    } else if (/myeloma/.test(d)) {
      add("lenalidomide", "immunomodulator", "25 mg days 1-21"); add("dexamethasone", "corticosteroid", "40 mg weekly");
    } else if (/pancrea/.test(d)) {
      add("gemcitabine", "chemotherapy", "1000 mg/m² weekly"); add("nab-paclitaxel", "chemotherapy", "125 mg/m² weekly");
    } else {
      add("carboplatin", "platinum chemotherapy", "AUC 5 every 3 weeks"); add("paclitaxel", "taxane chemotherapy", "175 mg/m² every 3 weeks");
    }
    add("ondansetron", "antiemetic", "8 mg as needed");
    // Some patients are on an anticoagulant for a clot: a common trial exclusion, so a useful near-miss.
    if (rnd() < 0.2) add("apixaban", "anticoagulant", "5 mg twice daily");
  }
  return meds;
}

function comorbidities(specialty, rnd) {
  const out = [];
  if (rnd() < (specialty === "Cardiology" ? 0.6 : 0.35)) out.push({ description: "Essential hypertension", icd10_code: "I10", stage: "", diagnosed_on: daysAgo(1500) });
  if (rnd() < 0.3) out.push({ description: "Type 2 diabetes mellitus", icd10_code: "E11.9", stage: "", diagnosed_on: daysAgo(2000) });
  if (rnd() < 0.15) out.push({ description: "Chronic kidney disease", icd10_code: "N18.4", stage: "4", diagnosed_on: daysAgo(700) });
  return out;
}

/** Three results per lab over about nine months, drifting toward a final value; a few patients cross common cutoffs. */
function labs(specialty, dx, conditions, rnd) {
  const ckd = conditions.some((c) => /kidney/i.test(c.description));
  const diabetic = conditions.some((c) => /diabetes/i.test(c.description));
  const hf = /heart failure|cardiomyopathy|hfref/i.test(dx);
  const spec = [
    ["eGFR", "mL/min/1.73m²", ckd ? [38, 24] : rnd() < 0.15 ? [52, 31] : [85, 72], 0],
    ["Creatinine", "mg/dL", ckd ? [1.7, 2.6] : [0.9, 1.1], 2],
    ["Hemoglobin", "g/dL", specialty === "Oncology" ? [12.8, 10.6] : [13.9, 13.5], 1],
    ["Platelets", "10^9/L", [250, specialty === "Oncology" ? 140 : 230], 0],
    ["ALT", "U/L", [24, rnd() < 0.1 ? 118 : 30], 0],
    ["Total bilirubin", "mg/dL", [0.6, 0.8], 1],
  ];
  if (specialty === "Oncology") spec.push(["ANC", "10^9/L", [4.2, rnd() < 0.15 ? 1.2 : 3.1], 1], ["Albumin", "g/dL", [4.1, 3.5], 1]);
  if (specialty === "Cardiology") {
    spec.push(["LVEF", "%", hf ? [35, 28] : [58, 55], 0], ["NT-proBNP", "pg/mL", hf ? [1800, 2600] : [140, 180], 0],
      ["Potassium", "mmol/L", [4.3, rnd() < 0.15 ? 5.6 : 4.5], 1], ["LDL cholesterol", "mg/dL", [128, 82], 0]);
  }
  if (diabetic) spec.push(["HbA1c", "%", [8.1, 7.4], 1]);
  const out = [];
  for (const [name, unit, [from, to], digits] of spec) {
    [270, 150, 30].forEach((days, i) => {
      const t = i / 2;
      const jitter = 1 + (rnd() - 0.5) * 0.06;
      const value = Number(((from + (to - from) * t) * jitter).toFixed(digits));
      out.push({ name, unit, value, observed_on: daysAgo(days - Math.floor(rnd() * 10)) });
    });
  }
  return out;
}

function icd10(dx) {
  const d = dx.toLowerCase();
  const map = [[/breast/, "C50.911"], [/lung|nsclc/, "C34.90"], [/colo|rectal/, "C18.9"], [/melanoma/, "C43.9"],
    [/prostate/, "C61"], [/pancrea/, "C25.9"], [/lymphoma/, "C85.90"], [/myeloma/, "C90.00"], [/ovar/, "C56.9"],
    [/heart failure|hfref/, "I50.22"], [/hfpef/, "I50.32"], [/cardiomyopathy/, "I42.9"], [/atrial fib|afib/, "I48.91"],
    [/coronary|cad/, "I25.10"], [/infarct|stemi/, "I21.9"], [/aortic stenosis/, "I35.0"], [/hypertension/, "I10"]];
  return map.find(([re]) => re.test(d))?.[1] ?? null;
}

// ------------------------------------------------------------------ helpers

/** Every row of a namespace, paging by id. Queries only. */
async function readAll(namespace, extra) {
  const ns = tp.namespace(namespace);
  const out = [];
  let last = null;
  for (;;) {
    let res;
    try {
      res = await ns.query({ rank_by: ["id", "asc"], top_k: 1000, ...(last != null ? { filters: ["id", "Gt", last] } : {}), ...extra });
    } catch (e) {
      if (e?.status === 404) return out;
      throw e;
    }
    const rows = res.rows ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
    last = rows.at(-1).id;
  }
}

async function tpufCounts(patientIds) {
  const count = async (namespace) => {
    try {
      const r = await tp.namespace(namespace).query({ aggregate_by: { c: ["Count"] } });
      return Number(r.aggregations?.c ?? 0);
    } catch (e) {
      if (e?.status === 404) return 0;
      throw e;
    }
  };
  const names = ["ts-trials", "ts-pubmed", "ts-patients", ...patientIds.map((id) => `ts-patient-${id}`)];
  const counts = await Promise.all(names.map(count));
  return Object.fromEntries(names.map((n, i) => [n, counts[i]]));
}

async function pgCounts() {
  const [{ exists }] = await sql`select to_regclass('public.patients') is not null as exists`;
  if (!exists) return { tables: "not created yet" };
  const [r] = await sql`select (select count(*) from patients)::int as patients, (select count(*) from conditions)::int as conditions,
    (select count(*) from medications)::int as medications, (select count(*) from observations)::int as observations`;
  return r;
}

function printCounts(title, counts) {
  const entries = Object.entries(counts);
  const notes = entries.filter(([k]) => k.startsWith("ts-patient-"));
  const rest = entries.filter(([k]) => !k.startsWith("ts-patient-"));
  console.log(`\n${title}:`);
  for (const [k, v] of rest) console.log(`  ${k.padEnd(14)} ${v}`);
  if (notes.length) console.log(`  ts-patient-*   ${notes.reduce((a, [, v]) => a + v, 0)} notes across ${notes.length} namespaces`);
}

function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }
function dob(age, rnd) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  d.setDate(d.getDate() - 1 - Math.floor(rnd() * 360)); // birthday already passed this year, so the age stays the same
  return d.toISOString().slice(0, 10);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
function fail(msg) { console.error(msg); process.exit(1); }
