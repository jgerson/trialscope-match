"use client";
// The structured patient record from Supabase: conditions, medications and the latest labs and biomarkers, each editable
// in place. Every change is one Postgres insert or update; the panel then shows the record as the database returns it.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Database, Loader2, Pencil, Plus, X } from "lucide-react";
import type { PatientRecord } from "@/lib/types";
import { useApp } from "./app-shell";
import { cx } from "./ui";

type Change = Record<string, unknown> & { op: string };
const today = () => new Date().toISOString().slice(0, 10);
const input = "rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[13px] min-w-0";

export function RecordPanel({ initial, loadMs }: { initial: PatientRecord; loadMs: number }) {
  const { readOnly } = useApp();
  const router = useRouter();
  const [record, setRecord] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ op: string; ms: number } | null>(null);
  const [open, setOpen] = useState<null | "patient" | "condition" | "medication" | "result">(null);
  const [showStopped, setShowStopped] = useState(false);
  const [showQueries, setShowQueries] = useState(false);
  const p = record.patient;
  const queryMs = Math.max(...record.queries.map((q) => q.ms), 0);

  const change = async (body: Change): Promise<boolean> => {
    if (readOnly || busy) return false;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/patients/${p.id}/record`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed.");
      setRecord(json.record); setLast({ op: body.op, ms: json.ms }); setOpen(null);
      router.refresh(); // header, sidebar and copilot read the patient from the server
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const current = record.medications.filter((m) => !m.stopped_on);
  const stopped = record.medications.filter((m) => m.stopped_on);
  const labs = record.latest.filter((o) => o.kind === "lab");
  const markers = record.latest.filter((o) => o.kind === "biomarker");

  return (
    <section aria-labelledby="record-h" className="rounded-2xl border border-line bg-surface p-5 text-[13.5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="record-h" className="text-[15px] font-semibold text-ink">Patient record</h2>
        <button type="button" onClick={() => setShowQueries((v) => !v)} aria-expanded={showQueries} aria-controls="record-queries"
          className="inline-flex items-center gap-1.5 rounded-md bg-paper px-2 py-0.5 font-mono text-[11.5px] text-slate ring-1 ring-line hover:text-ink-2 hover:ring-line-2">
          <Database size={12} />Supabase · {record.queries.length} queries in parallel · {Math.round(queryMs)} ms (page {loadMs} ms)
          <span className="font-sans font-semibold text-accent underline underline-offset-2">{showQueries ? "Hide SQL" : "Show SQL"}</span>
        </button>
      </div>
      {showQueries && <QueryList queries={record.queries} />}
      {last && <p className="mt-1 text-[12px] text-trials">Saved: {last.op.replace("-", " ")} in {last.ms} ms (one Postgres statement).</p>}
      {error && <p className="mt-2 text-[12.5px] text-red-700">{error}</p>}

      {/* demographics */}
      <Block title="Demographics" action={!readOnly && <IconBtn label="Edit demographics" onClick={() => setOpen(open === "patient" ? null : "patient")}><Pencil size={13} /></IconBtn>}>
        <p className="text-ink-2">
          {p.age}-year-old {p.sex.toLowerCase()}, born {p.date_of_birth} · {p.city}{p.state ? `, ${p.state}` : ""} · {p.specialty}
          {p.ecog != null && <> · ECOG {p.ecog}</>}
        </p>
        {open === "patient" && (
          <Form busy={busy} onCancel={() => setOpen(null)} onSubmit={(f) => change({ op: "update-patient", fields: {
            name: f.get("name"), date_of_birth: f.get("dob"), sex: f.get("sex"), city: f.get("city"), state: f.get("state"), ecog: f.get("ecog") } })}>
            <input name="name" defaultValue={p.name} aria-label="Name" className={cx(input, "col-span-2")} />
            <input name="dob" type="date" defaultValue={p.date_of_birth} aria-label="Date of birth" className={input} />
            <select name="sex" defaultValue={p.sex} aria-label="Sex" className={input}><option>Female</option><option>Male</option></select>
            <input name="city" defaultValue={p.city} placeholder="City" aria-label="City" className={input} />
            <input name="state" defaultValue={p.state} placeholder="State" aria-label="State" className={input} />
            <select name="ecog" defaultValue={p.ecog ?? ""} aria-label="ECOG" className={input}>
              <option value="">ECOG not recorded</option>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>ECOG {n}</option>)}
            </select>
          </Form>
        )}
      </Block>

      {/* conditions */}
      <Block title="Conditions" count={record.conditions.length}
        action={!readOnly && <IconBtn label="Add condition" onClick={() => setOpen(open === "condition" ? null : "condition")}><Plus size={14} /></IconBtn>}>
        <ul className="space-y-1.5">
          {record.conditions.map((c) => (
            <li key={c.id} className={cx("flex flex-wrap items-center gap-x-2 gap-y-1", c.status === "resolved" && "text-slate line-through decoration-line-2")}>
              <span className="font-medium text-ink">{c.description}</span>
              {c.is_primary && <span className="rounded bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-strong">Primary</span>}
              {c.icd10_code && <span className="font-mono text-[11.5px] text-slate">{c.icd10_code}</span>}
              {!readOnly && c.status === "active" ? (
                <>
                  <StageEdit stage={c.stage} busy={busy} onSave={(stage) => change({ op: "update-condition", id: c.id, stage })} />
                  <button disabled={busy} onClick={() => change({ op: "update-condition", id: c.id, status: "resolved" })}
                    className="text-[12px] text-slate underline-offset-2 hover:text-ink hover:underline">Resolve</button>
                </>
              ) : c.stage && <span className="text-slate">stage {c.stage}</span>}
              {c.diagnosed_on && <span className="text-[12px] text-slate">since {c.diagnosed_on}</span>}
            </li>
          ))}
        </ul>
        {open === "condition" && (
          <Form busy={busy} onCancel={() => setOpen(null)} onSubmit={(f) => change({ op: "add-condition",
            description: f.get("description"), stage: f.get("stage"), icd10_code: f.get("icd10"), diagnosed_on: f.get("date") })}>
            <input name="description" placeholder="e.g. Type 2 diabetes" aria-label="Condition" className={cx(input, "col-span-2")} required />
            <input name="stage" placeholder="Stage (optional)" aria-label="Stage" className={input} />
            <input name="icd10" placeholder="ICD-10 (optional)" aria-label="ICD-10 code" className={input} />
            <input name="date" type="date" defaultValue={today()} aria-label="Diagnosed on" className={input} />
          </Form>
        )}
      </Block>

      {/* medications */}
      <Block title="Current medications" count={current.length}
        action={!readOnly && <IconBtn label="Add medication" onClick={() => setOpen(open === "medication" ? null : "medication")}><Plus size={14} /></IconBtn>}>
        {!current.length && <p className="text-slate">None recorded.</p>}
        <ul className="space-y-1.5">
          {current.map((m) => (
            <li key={m.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-ink">{m.name}</span>
              {m.dose && <span className="text-ink-2">{m.dose}</span>}
              {m.drug_class && <span className="text-[12px] text-slate">{m.drug_class}</span>}
              {m.started_on && <span className="text-[12px] text-slate">since {m.started_on}</span>}
              {!readOnly && (
                <button disabled={busy} onClick={() => change({ op: "stop-medication", id: m.id, stopped_on: today() })}
                  className="text-[12px] text-slate underline-offset-2 hover:text-ink hover:underline">Stop today</button>
              )}
            </li>
          ))}
        </ul>
        {stopped.length > 0 && (
          <button onClick={() => setShowStopped((v) => !v)} className="mt-2 text-[12px] text-slate hover:text-ink">
            {showStopped ? "Hide" : "Show"} {stopped.length} stopped
          </button>
        )}
        {showStopped && (
          <ul className="mt-1 space-y-1 text-[12.5px] text-slate">
            {stopped.map((m) => <li key={m.id}>{m.name} {m.dose} · {m.started_on ?? "?"} to {m.stopped_on}</li>)}
          </ul>
        )}
        {open === "medication" && (
          <Form busy={busy} onCancel={() => setOpen(null)} onSubmit={(f) => change({ op: "add-medication",
            name: f.get("name"), dose: f.get("dose"), drug_class: f.get("class"), started_on: f.get("date") })}>
            <input name="name" placeholder="e.g. apixaban" aria-label="Medication" className={input} required />
            <input name="dose" placeholder="Dose, e.g. 5 mg twice daily" aria-label="Dose" className={input} />
            <input name="class" placeholder="Class, e.g. anticoagulant" aria-label="Drug class" className={input} />
            <input name="date" type="date" defaultValue={today()} aria-label="Started on" className={input} />
          </Form>
        )}
      </Block>

      {/* results */}
      <Block title="Latest results" count={labs.length + markers.length}
        action={!readOnly && <IconBtn label="Add result" onClick={() => setOpen(open === "result" ? null : "result")}><Plus size={14} /></IconBtn>}>
        {markers.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {markers.map((o) => (
              <span key={o.id} title={`Tested ${o.observed_on}`} className="rounded-lg bg-paper px-2 py-0.5 text-[12.5px] text-ink-2 ring-1 ring-line">
                {o.name} <b className="font-semibold">{o.result}</b>
              </span>
            ))}
          </div>
        )}
        {labs.length > 0 && (
          <table className="w-full text-left text-[12.5px]">
            <tbody>
              {labs.map((o) => (
                <tr key={o.id} className="border-t border-line first:border-0">
                  <td className="py-1 pr-3 text-ink-2">{o.name}</td>
                  <td className="py-1 pr-3 font-semibold text-ink tabular-nums">{o.value} <span className="font-normal text-slate">{o.unit}</span></td>
                  <td className="py-1 text-right text-slate tabular-nums">{o.observed_on}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {open === "result" && <ResultForm busy={busy} onCancel={() => setOpen(null)} onSubmit={change} />}
      </Block>
    </section>
  );
}

function ResultForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (c: Change) => Promise<boolean> }) {
  const [kind, setKind] = useState<"lab" | "biomarker">("lab");
  return (
    <Form busy={busy} onCancel={onCancel} onSubmit={(f) => onSubmit({ op: "add-observation", kind, name: f.get("name"),
      value: f.get("value"), unit: f.get("unit"), result: f.get("result"), observed_on: f.get("date") })}>
      <select value={kind} onChange={(e) => setKind(e.target.value as "lab" | "biomarker")} aria-label="Kind" className={input}>
        <option value="lab">Lab</option><option value="biomarker">Biomarker</option>
      </select>
      <input name="name" placeholder={kind === "lab" ? "e.g. eGFR" : "e.g. PD-L1"} aria-label="Name" className={input} required />
      {kind === "lab" ? (<>
        <input name="value" type="number" step="any" placeholder="Value" aria-label="Value" className={input} required />
        <input name="unit" placeholder="Unit, e.g. mL/min/1.73m²" aria-label="Unit" className={input} required />
      </>) : (
        <input name="result" placeholder="Result, e.g. positive or 50%" aria-label="Result" className={cx(input, "col-span-2")} required />
      )}
      <input name="date" type="date" defaultValue={today()} max={today()} aria-label="Result date" className={input} />
    </Form>
  );
}

function StageEdit({ stage, busy, onSave }: { stage: string; busy: boolean; onSave: (s: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(stage);
  if (!editing) {
    return (
      <button onClick={() => { setV(stage); setEditing(true); }} title="Change stage"
        className="rounded px-1 text-ink-2 hover:bg-paper">{stage ? `stage ${stage}` : <span className="text-slate">add stage</span>}</button>
    );
  }
  return (
    <form className="inline-flex gap-1" onSubmit={async (e) => { e.preventDefault(); if (await onSave(v.trim())) setEditing(false); }}>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label="Stage" className="w-24 rounded border border-line bg-paper px-1.5 py-0.5 text-[12.5px]" />
      <button disabled={busy} className="rounded bg-ink px-2 text-[12px] font-semibold text-white">Save</button>
      <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="text-slate"><X size={14} /></button>
    </form>
  );
}

function Block({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-slate">{title}{count != null && <span className="ml-1 tabular-nums">{count}</span>}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button aria-label={label} title={label} onClick={onClick} className="rounded-md p-1 text-slate hover:bg-paper hover:text-ink">{children}</button>;
}

function Form({ busy, onSubmit, onCancel, children }: { busy: boolean; onSubmit: (f: FormData) => void; onCancel: () => void; children: React.ReactNode }) {
  return (
    <form className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-paper/60 p-3 ring-1 ring-line"
      onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}>
      {children}
      <div className="col-span-2 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[13px] text-slate hover:text-ink">Cancel</button>
        <button disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-white disabled:bg-line-2">
          {busy && <Loader2 size={13} className="animate-spin" />}Save
        </button>
      </div>
    </form>
  );
}

// The statements behind the "Supabase" line: what each query was for, how long it took and the SQL Postgres received.
function QueryList({ queries }: { queries: PatientRecord["queries"] }) {
  return (
    <div id="record-queries" className="mt-3 space-y-3 rounded-xl bg-paper/60 p-3 ring-1 ring-line">
      {queries.map((q) => (
        <div key={q.label}>
          <p className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
            <span className="font-mono font-medium text-ink-2">{q.label}</span>
            <span className="tabular-nums text-slate">{q.ms < 10 ? q.ms.toFixed(1) : Math.round(q.ms)} ms · {q.rows} {q.rows === 1 ? "row" : "rows"}</span>
          </p>
          {q.sql
            ? <pre className="mt-1 overflow-x-auto rounded-lg bg-surface p-2.5 font-mono text-[11.5px] leading-relaxed text-ink-2 ring-1 ring-line">{q.sql}</pre>
            : <p className="mt-1 text-[12px] text-slate">Statement not available.</p>}
        </div>
      ))}
      <p className="text-[12px] leading-relaxed text-slate">
        The SQL as Postgres received it. <code className="font-mono">$1</code> is this patient&apos;s id, sent separately
        from the statement. The four run at the same time on separate pooled connections, so the panel&apos;s time is the
        slowest of them; each time includes the round trip to Supabase.
      </p>
    </div>
  );
}
