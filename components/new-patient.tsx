"use client";
// Add a patient: demographics and a primary diagnosis, saved in one Postgres transaction. Medications, labs and
// biomarkers are added afterwards from the patient's record panel.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useApp } from "./app-shell";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-[14px]";
const today = () => new Date().toISOString().slice(0, 10);

export function NewPatientForm() {
  const { readOnly, selectPatient } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (f: FormData) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/patients", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(f.entries())) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Couldn't create the patient.");
      router.refresh(); // the sidebar's patient list comes from the server
      selectPatient(json.patient.id, true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (readOnly) return <p className="p-10 text-sm text-slate">Editing is turned off on this deployment.</p>;

  return (
    <div className="mx-auto max-w-2xl px-5 py-10 sm:px-8">
      <h1 className="font-display text-[36px] leading-tight tracking-tight">New patient</h1>
      <p className="mt-2 text-[14px] text-slate">
        Saved to Supabase: one row in <code className="font-mono text-[13px]">patients</code> and one in{" "}
        <code className="font-mono text-[13px]">conditions</code>, in a single transaction. Add medications, labs and
        biomarkers from the record afterwards. Synthetic data only.
      </p>
      <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(new FormData(e.currentTarget)); }}>
        <Label text="Name" wide><input name="name" required className={field} /></Label>
        <Label text="Date of birth"><input name="date_of_birth" type="date" max={today()} required className={field} /></Label>
        <Label text="Sex"><select name="sex" className={field}><option>Female</option><option>Male</option></select></Label>
        <Label text="City"><input name="city" className={field} /></Label>
        <Label text="State"><input name="state" className={field} /></Label>
        <Label text="Specialty"><select name="specialty" className={field}><option>Oncology</option><option>Cardiology</option></select></Label>
        <Label text="ECOG (optional)">
          <select name="ecog" defaultValue="" className={field}>
            <option value="">Not recorded</option>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
          </select>
        </Label>
        <h2 className="mt-2 text-[13px] font-semibold text-ink sm:col-span-2">Primary diagnosis</h2>
        <Label text="Diagnosis" wide><input name="diagnosis" placeholder="e.g. HER2-positive breast cancer" required className={field} /></Label>
        <Label text="Stage (optional)"><input name="stage" placeholder="e.g. IIIA or NYHA II" className={field} /></Label>
        <Label text="ICD-10 (optional)"><input name="icd10_code" placeholder="e.g. C50.911" className={field} /></Label>
        <Label text="Diagnosed on (optional)"><input name="diagnosed_on" type="date" max={today()} className={field} /></Label>
        {error && <p className="text-sm text-red-700 sm:col-span-2">{error}</p>}
        <div className="sm:col-span-2">
          <button disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-[14px] font-semibold text-white disabled:bg-line-2">
            {busy && <Loader2 size={15} className="animate-spin" />}Create patient
          </button>
        </div>
      </form>
    </div>
  );
}

function Label({ text, wide, children }: { text: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={wide ? "sm:col-span-2" : ""}>
      <span className="mb-1 block text-[12.5px] font-medium text-ink-2">{text}</span>
      {children}
    </label>
  );
}
