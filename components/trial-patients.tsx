"use client";
// "Candidate patients" on the trial page: which of the clinic's patients could fit this trial, from their structured
// record. The criteria become rules once per trial (a model call, cached in Supabase); one SQL query then scores every
// patient on every rule. Met is green, failed red, unknown grey (the record doesn't say).
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, ClipboardCheck, Database, Loader2, Users } from "lucide-react";
import type { RuleStatus, TrialMatch } from "@/lib/trial-match";
import { useApp } from "./app-shell";
import { cx } from "./ui";

type Result = TrialMatch & { labels: string[] };

const CHIP: Record<RuleStatus, string> = {
  met: "bg-trials-soft text-trials",
  failed: "bg-red-50 text-red-800",
  unknown: "bg-paper text-slate ring-1 ring-line",
};
const MARK: Record<RuleStatus, string> = { met: "✓", failed: "✗", unknown: "?" };
const SHOWN = 6;

export function TrialPatients({ nct }: { nct: string }) {
  const { selectPatient } = useApp();
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [allExcluded, setAllExcluded] = useState(false);

  useEffect(() => {
    let stop = false;
    setData(null); setError(null); setSlow(false);
    const timer = setTimeout(() => setSlow(true), 1500);
    fetch(`/api/trial-patients?nct=${encodeURIComponent(nct)}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Couldn't match patients."); return j as Result; })
      .then((j) => { if (!stop) setData(j); })
      .catch((e) => { if (!stop) setError((e as Error).message); })
      .finally(() => clearTimeout(timer));
    return () => { stop = true; clearTimeout(timer); };
  }, [nct]);

  const check = (id: string) => {
    selectPatient(id, false);
    // The checklist below re-renders for the newly selected patient.
    setTimeout(() => document.getElementById("eligibility")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  return (
    <section aria-labelledby="tp-h" className="mt-8 rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tp-h" className="flex items-center gap-2 text-[16px] font-semibold text-ink"><Users size={17} />Candidate patients</h2>
        {data && !!data.labels.length && (
          <span className="text-[12.5px] text-slate">
            {data.candidates.length} possible · {data.excluded.length} excluded · {data.rules.notCheckable.length} criteria not checkable from the record
          </span>
        )}
      </div>

      {!data && !error && (
        <p className="mt-3 inline-flex items-center gap-2 text-[13px] text-slate">
          <Loader2 size={14} className="animate-spin" />
          {slow ? "Turning this trial's criteria into rules. The first time for a trial takes about 15 seconds; after that it's instant." : "Matching patients…"}
        </p>
      )}
      {error && <p className="mt-3 text-[13px] text-red-700">{error}</p>}

      {data && !data.labels.length && (
        <div className="mt-2 space-y-2 text-[13px] text-ink-2">
          <p>
            Nothing in this trial can be checked against the record: it sets no age or sex limits, and none of its
            criteria map to a diagnosis, drug, lab or other field the record holds. Select a patient and run the
            eligibility checklist below instead.
          </p>
          {!!data.rules.notCheckable.length && (
            <p className="text-[12.5px] text-slate">Criteria read but not checkable: {data.rules.notCheckable.join(" · ")}</p>
          )}
        </div>
      )}

      {data && !!data.labels.length && (
        <>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 font-mono text-[11.5px] text-slate">
            <span>{data.labels.length} rules, {data.rules.cached ? `cached, read in ${data.rules.ms} ms` : `extracted by the model in ${(data.rules.ms / 1000).toFixed(1)} s`}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1"><Database size={11} aria-hidden />Supabase: one query over {data.candidates.length + data.excluded.length} patients in {Math.round(data.sql.ms)} ms</span>
            <button type="button" onClick={() => setShowSql((v) => !v)} className="font-sans font-semibold text-accent underline underline-offset-2">
              {showSql ? "Hide SQL" : "Show SQL"}
            </button>
          </p>
          {showSql && (
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-paper p-2.5 font-mono text-[11px] leading-relaxed text-ink-2 ring-1 ring-line">{data.sql.statement}</pre>
          )}

          {thin(data) && (
            <p className="mt-2 rounded-lg bg-paper px-3 py-2 text-[12.5px] text-ink-2 ring-1 ring-line">
              {thin(data) === "none"
                ? "None of this trial's criteria can be checked against the record beyond age and sex, so everyone in that range is listed. Treat this list as unscreened."
                : "Only the disease and basic limits could be checked; most of this trial's criteria need the full record or the protocol. Treat these as broad candidates."}
            </p>
          )}

          {!data.candidates.length ? (
            <p className="mt-3 text-[13px] text-slate">No patient meets every checkable rule. The closest are listed under excluded.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {data.candidates.map((c) => (
                <li key={c.patient.id} className="flex flex-wrap items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/patients/${c.patient.id}`} className="inline-flex flex-wrap items-baseline gap-x-2 hover:underline">
                      <span className="text-[14px] font-semibold text-ink">{c.patient.name}</span>
                      <span className="text-[12.5px] text-slate">{c.patient.age} · {c.patient.primary_dx}{c.patient.stage ? `, stage ${c.patient.stage}` : ""}</span>
                    </Link>
                    <p className="text-[12px] text-slate">{c.met} met · {c.unknown} unknown</p>
                    <Chips data={data} results={c.results} />
                  </div>
                  <button type="button" onClick={() => check(c.patient.id)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:bg-paper">
                    <ClipboardCheck size={14} />Check eligibility
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!!data.excluded.length && (
            <details className="group mt-2">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
                <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
                {data.excluded.length} excluded, closest first
              </summary>
              <ul className="mt-1 divide-y divide-line">
                {(allExcluded ? data.excluded : data.excluded.slice(0, SHOWN)).map((c) => (
                  <li key={c.patient.id} className="py-2">
                    <Link href={`/patients/${c.patient.id}`} className="text-[13px] font-medium text-ink hover:underline">{c.patient.name}</Link>
                    <span className="ml-2 text-[12px] text-slate">{c.patient.primary_dx} · {c.failed} failed</span>
                    <Chips data={data} results={c.results} only="failed" />
                  </li>
                ))}
              </ul>
              {data.excluded.length > SHOWN && (
                <button type="button" onClick={() => setAllExcluded((v) => !v)} className="mt-1 text-[12.5px] font-semibold text-ink-2 underline underline-offset-2">
                  {allExcluded ? "Show fewer" : `Show all ${data.excluded.length}`}
                </button>
              )}
            </details>
          )}

          <details className="group mt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
              <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
              How the criteria became rules
            </summary>
            <div className="mt-2 space-y-3 text-[12.5px]">
              <ul className="space-y-1">
                {data.rules.rules.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-slate">{r.section}</span>
                    <span><span className="font-medium text-ink-2">{data.labels[i]}</span> <span className="text-slate">← {r.criterion}</span></span>
                  </li>
                ))}
              </ul>
              {!!data.rules.notCheckable.length && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-slate">Not checkable from the record</p>
                  <p className="mt-1 text-slate">{data.rules.notCheckable.join(" · ")}</p>
                </div>
              )}
              <p className="text-[12px] text-slate">
                Age and sex come from the trial&apos;s structured fields; the rest were read from the criteria text by {data.rules.model}
                {data.rules.inTokens ? ` (${data.rules.inTokens.toLocaleString()} input, ${data.rules.outTokens?.toLocaleString()} output tokens)` : ""}, once,
                and cached in Supabase&apos;s <code className="font-mono">trial_rules</code> until the criteria change. Exclusions read as what the patient must
                satisfy, so ✓ always means fits. This is a screen, not an eligibility decision: run the checklist and review the full protocol.
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

/**
 * "none" when no rule came from the criteria text (only age and sex), "broad" when the only ones are about the disease
 * itself (specialty, diagnosis, stage), so the list is barely screened. Null otherwise.
 */
function thin(data: Result): "none" | "broad" | null {
  const fromCriteria = data.rules.rules.filter((r) => r.kind !== "age" && r.kind !== "sex");
  if (!fromCriteria.length) return "none";
  if (fromCriteria.every((r) => r.kind === "specialty" || r.kind === "diagnosis" || r.kind === "stage")) return "broad";
  return null;
}

function Chips({ data, results, only }: { data: Result; results: Result["candidates"][number]["results"]; only?: RuleStatus }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {results.map((x, i) => (only && x.status !== only ? null : (
        <span key={i} className={cx("rounded-md px-1.5 py-0.5 text-[11.5px]", CHIP[x.status])}
          title={`${data.rules.rules[i].criterion}\n${x.status === "unknown" ? "Not in the record" : x.evidence ?? "None on record"}`}>
          {data.labels[i]} {MARK[x.status]}
        </span>
      )))}
    </div>
  );
}
