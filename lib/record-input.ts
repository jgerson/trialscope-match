// Checks on record edits before they reach Postgres. The database enforces the same rules with constraints; these give
// a readable message first. Shared by the API routes only.
import "server-only";
import type { NewPatient, RecordChange } from "./patients";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const date = (v: unknown) => (typeof v === "string" && DATE.test(v) ? v : null);
const today = () => new Date().toISOString().slice(0, 10);

export class InputError extends Error {}
const need = (ok: unknown, msg: string) => { if (!ok) throw new InputError(msg); };

function ecogOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  need(Number.isInteger(n) && n >= 0 && n <= 5, "ECOG must be a whole number from 0 to 5.");
  return n;
}

export function parseNewPatient(b: Record<string, unknown>): NewPatient {
  const p: NewPatient = {
    name: text(b.name), date_of_birth: date(b.date_of_birth) ?? "", sex: text(b.sex), city: text(b.city, 80),
    state: text(b.state, 40), specialty: text(b.specialty) as NewPatient["specialty"], ecog: ecogOf(b.ecog),
    diagnosis: text(b.diagnosis), stage: text(b.stage, 40), icd10_code: text(b.icd10_code, 12) || null,
    diagnosed_on: date(b.diagnosed_on),
  };
  need(p.name, "Name is required.");
  need(p.date_of_birth && p.date_of_birth <= today(), "Date of birth must be a past date.");
  need(["Female", "Male"].includes(p.sex), "Sex must be Female or Male (the values trials filter on).");
  need(["Oncology", "Cardiology"].includes(p.specialty), "Specialty must be Oncology or Cardiology.");
  need(p.diagnosis, "A primary diagnosis is required.");
  return p;
}

export function parseChange(b: Record<string, unknown>): RecordChange {
  switch (b.op) {
    case "update-patient": {
      const f = (b.fields ?? {}) as Record<string, unknown>;
      const fields: Extract<RecordChange, { op: "update-patient" }>["fields"] = {};
      if ("name" in f) { fields.name = text(f.name); need(fields.name, "Name can't be empty."); }
      if ("date_of_birth" in f) { const d = date(f.date_of_birth); need(d && d <= today(), "Date of birth must be a past date."); fields.date_of_birth = d!; }
      if ("sex" in f) { fields.sex = text(f.sex); need(["Female", "Male"].includes(fields.sex), "Sex must be Female or Male."); }
      if ("city" in f) fields.city = text(f.city, 80);
      if ("state" in f) fields.state = text(f.state, 40);
      if ("ecog" in f) fields.ecog = ecogOf(f.ecog);
      return { op: "update-patient", fields };
    }
    case "add-condition": {
      const description = text(b.description);
      need(description, "Describe the condition.");
      return { op: "add-condition", description, stage: text(b.stage, 40), icd10_code: text(b.icd10_code, 12) || null, diagnosed_on: date(b.diagnosed_on) };
    }
    case "update-condition": {
      const id = Number(b.id);
      need(Number.isInteger(id), "Unknown condition.");
      const status = b.status === undefined ? undefined : text(b.status);
      need(status === undefined || status === "active" || status === "resolved", "Status must be active or resolved.");
      return { op: "update-condition", id, stage: b.stage === undefined ? undefined : text(b.stage, 40), status: status as "active" | "resolved" | undefined };
    }
    case "add-medication": {
      const name = text(b.name, 120);
      need(name, "Name the medication.");
      return { op: "add-medication", name, drug_class: text(b.drug_class, 80), dose: text(b.dose, 80), started_on: date(b.started_on) ?? today() };
    }
    case "stop-medication": {
      const id = Number(b.id);
      need(Number.isInteger(id), "Unknown medication.");
      return { op: "stop-medication", id, stopped_on: date(b.stopped_on) ?? today() };
    }
    case "add-observation": {
      const kind = b.kind === "biomarker" ? "biomarker" : "lab";
      const name = text(b.name, 80);
      need(name, "Name the lab or biomarker.");
      const observed_on = date(b.observed_on) ?? today();
      need(observed_on <= today(), "The result date can't be in the future.");
      if (kind === "lab") {
        const value = Number(b.value);
        need(b.value !== "" && b.value !== null && Number.isFinite(value), "A lab needs a numeric value.");
        const unit = text(b.unit, 30);
        need(unit, "A lab needs a unit.");
        return { op: "add-observation", kind, name, value, unit, result: "", observed_on };
      }
      const result = text(b.result, 80);
      need(result, "A biomarker needs a result, like positive, negative or 50%.");
      return { op: "add-observation", kind, name, value: null, unit: "", result, observed_on };
    }
    default:
      throw new InputError("Unknown change.");
  }
}

/** A Postgres error as a sentence: constraint names and codes mean little in the UI. */
export function dbMessage(e: unknown): string {
  const err = e as { code?: string; message?: string; constraint_name?: string };
  if (err.code === "23505" && err.constraint_name === "conditions_one_primary") return "This patient already has an active primary diagnosis.";
  if (err.code === "23514") return `The database rejected that value (${err.constraint_name ?? "check constraint"}).`;
  if (err.code === "42501") return "The app's database role isn't allowed to do that.";
  return err.message ?? "The database request failed.";
}
