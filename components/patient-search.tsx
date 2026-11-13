"use client";
// Search across all patients, at the top of the patient workspace: notes (turbopuffer), record attributes (Supabase),
// or both, where the attribute filters pick the patients in Postgres and the notes search runs over only those.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Database, Loader2, Plus, Search, X } from "lucide-react";
import type { AttrFilter, PatientSearchResult, SearchMode } from "@/lib/patient-search";
import type { Hit } from "@/lib/types";
import { ExplainDialog } from "./explain";
import { cx, highlight, Segmented } from "./ui";

type Options = { diagnoses: string[]; biomarkers: string[]; medications: string[]; labs: string[] };
type Kind = AttrFilter["kind"];

const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: "notes", label: "Notes", hint: "Every patient's notes in turbopuffer, by keyword and by meaning." },
  { value: "attributes", label: "Attributes", hint: "The structured record in Supabase: diagnosis, biomarkers, medications, labs, age, sex, ECOG." },
  { value: "both", label: "Both", hint: "The filters pick patients in Supabase, then the text searches only their notes in turbopuffer." },
];

const KINDS: { value: Kind; label: string }[] = [
  { value: "diagnosis", label: "Diagnosis" }, { value: "biomarker", label: "Biomarker" },
  { value: "medication", label: "Medication" }, { value: "lab", label: "Latest lab" },
  { value: "age", label: "Age" }, { value: "sex", label: "Sex" }, { value: "ecog", label: "ECOG" },
];

// Labels mirror filterLabel() in lib/patient-search.ts, which is server-only.
function label(f: AttrFilter): string {
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

const SHOWN = 8;
const input = "rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px]";

export function PatientSearch() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>("both");
  const [filters, setFilters] = useState<AttrFilter[]>([]);
  const [adding, setAdding] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PatientSearchResult | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [explain, setExplain] = useState<Hit | null>(null);

  // Suggestions for the filter inputs, once, the first time a filter is added. Without them the inputs still work.
  useEffect(() => {
    if (!adding || options) return;
    const none: Options = { diagnoses: [], biomarkers: [], medications: [], labs: [] };
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    fetch("/api/patient-search")
      .then(async (r) => {
        const j = r.ok ? await r.json() : {};
        setOptions({ diagnoses: list(j.diagnoses), biomarkers: list(j.biomarkers), medications: list(j.medications), labs: list(j.labs) });
      })
      .catch(() => setOptions(none));
  }, [adding, options]);

  // Only the latest search may set the results: a slow earlier response that arrives late is ignored.
  const latest = useRef(0);
  const run = async (nextFilters = filters, nextMode = mode) => {
    const id = ++latest.current;
    setBusy(true); setError(null); setShowAll(false);
    try {
      const res = await fetch("/api/patient-search", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q, mode: nextMode, filters: nextFilters }) });
      const json = await res.json();
      if (id !== latest.current) return;
      if (!res.ok) throw new Error(json.error ?? "Search failed.");
      setResult(json as PatientSearchResult);
    } catch (e) {
      if (id !== latest.current) return;
      setError((e as Error).message); setResult(null);
    } finally {
      if (id === latest.current) setBusy(false);
    }
  };

  const runnable = (fs: AttrFilter[]) => (mode === "notes" ? !!q.trim() : mode === "attributes" ? fs.length > 0 : !!q.trim() || fs.length > 0);
  const canRun = runnable(filters);
  const clear = () => { latest.current++; setResult(null); setError(null); setBusy(false); };
  const addFilter = (f: AttrFilter) => { const next = [...filters, f]; setFilters(next); setAdding(false); if (result) run(next); };
  // Removing the last thing a search needs clears the results rather than leaving the old ones on screen.
  const removeFilter = (i: number) => {
    const next = filters.filter((_, j) => j !== i);
    setFilters(next);
    if (!result) return;
    if (runnable(next)) run(next); else clear();
  };
  const patients = result?.patients ?? [];

  return (
    <section aria-label="Search across all patients" className="rounded-2xl border border-line bg-surface p-4">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (canRun) run(); }}>
        <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 focus-within:ring-1 focus-within:ring-ink">
          <Search size={15} className="text-slate" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} disabled={mode === "attributes"}
            placeholder={mode === "attributes" ? "Attributes only: add filters below" : "Search all patients' notes, like “tingling in feet”"}
            aria-label="Search notes across all patients" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-slate/70 disabled:opacity-60" />
        </label>
        <Segmented label="Search in" value={mode} options={MODES} onChange={(m) => { setMode(m); clear(); }} />
        <button type="submit" disabled={!canRun || busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:bg-line-2">
          {busy && <Loader2 size={14} className="animate-spin" />}Search
        </button>
        {result && (
          <button type="button" onClick={clear} className="px-1 text-[13px] text-slate hover:text-ink">Clear</button>
        )}
      </form>

      {mode !== "notes" && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {filters.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-md bg-paper px-2 py-1 text-[12.5px] text-ink-2 ring-1 ring-line">
              {label(f)}
              <button type="button" aria-label={`Remove ${label(f)}`} onClick={() => removeFilter(i)} className="text-slate hover:text-ink"><X size={12} /></button>
            </span>
          ))}
          {!adding && (
            <button type="button" onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium text-ink-2 hover:bg-paper">
              <Plus size={13} />Add filter
            </button>
          )}
          {!filters.length && !adding && <span className="text-[12px] text-slate">Filters read the record in Supabase.</span>}
        </div>
      )}
      {adding && mode !== "notes" && <FilterForm options={options} onAdd={addFilter} onCancel={() => setAdding(false)} />}

      {error && <p className="mt-3 text-[13px] text-red-700">{error}</p>}

      {result && (
        <div className="mt-3">
          <Timing result={result} />
          {!patients.length ? (
            <p className="mt-2 text-[13px] text-slate">No patients match.</p>
          ) : (
            <ul className="mt-1 divide-y divide-line">
              {(showAll ? patients : patients.slice(0, SHOWN)).map((m) => (
                <li key={m.patient.id} className="py-2.5">
                  <Link href={`/patients/${m.patient.id}`} className="group inline-flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[14px] font-semibold text-ink group-hover:underline">{m.patient.name}</span>
                    <span className="text-[12.5px] text-slate">{m.patient.age} · {m.patient.sex.toLowerCase()} · {m.patient.primary_dx}{m.patient.stage ? `, stage ${m.patient.stage}` : ""}</span>
                  </Link>
                  {!!m.evidence.length && (
                    <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-2">
                      {m.evidence.map((e, i) => (
                        <li key={i} className="inline-flex items-baseline gap-1" title={e.filter}><Check size={11} className="shrink-0 text-trials" aria-hidden />{e.text}</li>
                      ))}
                    </ul>
                  )}
                  {m.notes.map((h) => (
                    <div key={h.key} className="mt-1.5 rounded-lg bg-paper px-2.5 py-1.5 text-[12.5px]">
                      <p className="text-slate">
                        <span className="font-medium text-ink-2">{highlight(h.title, h.terms)}</span> · {h.meta.slice(0, 2).join(" · ")}
                        {result.turbopuffer && (
                          <button type="button" onClick={() => setExplain(h)}
                            className="ml-2 font-semibold text-accent underline underline-offset-2">Why this result?</button>
                        )}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-ink-2">{highlight(h.snippet, h.terms)}</p>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {patients.length > SHOWN && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 text-[12.5px] font-semibold text-ink-2 underline underline-offset-2">
              {showAll ? "Show fewer" : `Show all ${patients.length} patients`}
            </button>
          )}
        </div>
      )}
      {explain && result?.turbopuffer && (
        <ExplainDialog hit={explain} search={result.turbopuffer.search} context="Notes search across patients for" onClose={() => setExplain(null)} />
      )}
    </section>
  );
}

// Which store answered, in order, and how long each took.
function Timing({ result: r }: { result: PatientSearchResult }) {
  const n = r.patients.length;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 font-mono text-[11.5px] text-slate">
      <span className="font-sans text-[12.5px] font-semibold text-ink-2">{n} {n === 1 ? "patient" : "patients"}</span>
      {r.supabase && (
        <span className="inline-flex items-center gap-1" title={r.supabase.sql}>
          · <Database size={11} aria-hidden />Supabase: {r.supabase.matched} matched the filters in {Math.round(r.supabase.ms)} ms
        </span>
      )}
      {r.supabase && r.turbopuffer && <span>→</span>}
      {r.turbopuffer && (
        <span>
          {r.supabase ? "" : "· "}turbopuffer: {r.turbopuffer.notesReturned} notes
          {r.turbopuffer.filteredTo != null ? ` from ${r.turbopuffer.filteredTo} patients` : " across all patients"} in {r.turbopuffer.ms} ms
        </span>
      )}
    </p>
  );
}

function FilterForm({ options, onAdd, onCancel }: { options: Options | null; onAdd: (f: AttrFilter) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>("diagnosis");
  const [text, setText] = useState("");
  const [when, setWhen] = useState<"current" | "ever" | "never">("current");
  const [op, setOp] = useState<">=" | "<=">(">=");
  const [num, setNum] = useState("");
  const [num2, setNum2] = useState("");
  const [sex, setSex] = useState<"Female" | "Male">("Female");
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); setErr(null); }, [kind]);

  const list = kind === "diagnosis" ? options?.diagnoses : kind === "biomarker" ? options?.biomarkers
    : kind === "medication" ? options?.medications : kind === "lab" ? options?.labs : undefined;

  const submit = () => {
    const n = num.trim() === "" ? undefined : Number(num);
    const n2 = num2.trim() === "" ? undefined : Number(num2);
    if (["diagnosis", "biomarker", "medication", "lab"].includes(kind) && !text.trim()) return setErr("Enter a value first.");
    if ((kind === "lab" || kind === "ecog") && (n == null || !Number.isFinite(n))) return setErr("Enter a number.");
    if (kind === "age" && n == null && n2 == null) return setErr("Enter a minimum, a maximum or both.");
    if (kind === "age" && [n, n2].some((v) => v != null && !Number.isFinite(v))) return setErr("Ages must be numbers.");
    const t = text.trim();
    onAdd(kind === "diagnosis" || kind === "biomarker" ? { kind, text: t }
      : kind === "medication" ? { kind, text: t, when }
      : kind === "lab" ? { kind, name: t, op, value: n! }
      : kind === "age" ? { kind, min: n, max: n2 }
      : kind === "sex" ? { kind, value: sex }
      : { kind: "ecog", max: n! });
  };

  return (
    <div className="mt-2 rounded-xl bg-paper/70 p-3 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } if (e.key === "Escape") onCancel(); }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Filter on" className={input}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        {kind === "medication" && (
          <select value={when} onChange={(e) => setWhen(e.target.value as typeof when)} aria-label="When" className={input}>
            <option value="current">currently on</option><option value="ever">ever on</option><option value="never">never on</option>
          </select>
        )}
        {list && (
          <>
            <input ref={first} value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} list="ps-options"
              placeholder={kind === "diagnosis" ? "lung" : kind === "biomarker" ? "ALK" : kind === "medication" ? "anticoagulant or apixaban" : "eGFR"}
              aria-label={kind === "lab" ? "Lab name" : "Contains"} className={cx(input, "w-52")} />
            <datalist id="ps-options">{list.map((v) => <option key={v} value={v} />)}</datalist>
          </>
        )}
        {kind === "lab" && (
          <select value={op} onChange={(e) => setOp(e.target.value as typeof op)} aria-label="Comparison" className={input}>
            <option value=">=">≥</option><option value="<=">≤</option>
          </select>
        )}
        {(kind === "lab" || kind === "ecog") && (
          <input ref={kind === "ecog" ? first : undefined} value={num} onChange={(e) => { setNum(e.target.value); setErr(null); }} inputMode="decimal"
            placeholder={kind === "ecog" ? "max, like 1" : "value"} aria-label={kind === "ecog" ? "Maximum ECOG" : "Value"} className={cx(input, "w-24")} />
        )}
        {kind === "age" && (
          <>
            <input ref={first} value={num} onChange={(e) => { setNum(e.target.value); setErr(null); }} inputMode="numeric" placeholder="min" aria-label="Minimum age" className={cx(input, "w-20")} />
            <span className="text-slate">to</span>
            <input value={num2} onChange={(e) => { setNum2(e.target.value); setErr(null); }} inputMode="numeric" placeholder="max" aria-label="Maximum age" className={cx(input, "w-20")} />
          </>
        )}
        {kind === "sex" && (
          <select value={sex} onChange={(e) => setSex(e.target.value as typeof sex)} aria-label="Sex" className={input}>
            <option>Female</option><option>Male</option>
          </select>
        )}
        <button type="button" onClick={submit} className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-white">Add</button>
        <button type="button" onClick={onCancel} className="px-1 text-[13px] text-slate hover:text-ink">Cancel</button>
      </div>
      {err && <p className="mt-1.5 text-[12.5px] text-red-700">{err}</p>}
    </div>
  );
}
