"use client";
// "What the save did": one note save explained. Insert or update and what changed, the SQL statement Postgres ran,
// and where the time went.
import { useEffect, useState } from "react";
import type { Note, WriteReport } from "@/lib/types";
import { cx } from "./ui";

/** Where a saved note stands in the turbopuffer search index (match-notes). */
export type IndexState =
  | { state: "waiting"; seconds: number; error?: string | null }
  | { state: "indexed"; seconds: number }
  | { state: "unknown" };

/**
 * After a save, poll whether the saved version has reached turbopuffer, and measure how long it took from the moment the
 * save came back. Fast at first (the save itself indexes right after responding), then slower, up to the once-a-minute
 * sweep that retries anything the save couldn't index.
 */
export function useIndexStatus(noteId: string | undefined, patientId: string, savedAt: number | undefined): IndexState {
  const [s, setS] = useState<IndexState>({ state: "unknown" });
  useEffect(() => {
    if (!noteId || !savedAt) { setS({ state: "unknown" }); return; }
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const elapsed = (Date.now() - savedAt) / 1000;
      try {
        const res = await fetch(`/api/notes/index-status?id=${encodeURIComponent(noteId)}&patientId=${encodeURIComponent(patientId)}`, { cache: "no-store" });
        const j = await res.json();
        if (stop) return;
        if (res.ok && j.indexed) { setS({ state: "indexed", seconds: elapsed }); return; }
        setS({ state: "waiting", seconds: elapsed, error: res.ok ? j.error : null });
      } catch {
        if (stop) return;
        setS({ state: "waiting", seconds: elapsed });
      }
      if (elapsed < 150) timer = setTimeout(tick, elapsed < 10 ? 400 : 5000);
    };
    setS({ state: "waiting", seconds: 0 });
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [noteId, patientId, savedAt]);
  return s;
}

const secs = (n: number) => (n < 10 ? `${n.toFixed(1)} s` : `${Math.round(n)} s`);

/** One short phrase for the save banner: "searchable in 1.3 s" or "indexing for search…". */
export function indexPhrase(s: IndexState): string | null {
  if (s.state === "indexed") return `searchable in ${secs(s.seconds)}`;
  if (s.state === "waiting") return s.seconds > 10 ? "waiting to be indexed" : "indexing for search…";
  return null;
}

const ms = (n: number) => (n < 10 ? `${n.toFixed(1)} ms` : `${Math.round(n).toLocaleString()} ms`);

const stripMd = (l: string) => l.replace(/^[#>*\-\d.\s]+/, "").replace(/[*_`]/g, "").trim();

/** Body lines that weren't in the previous version, as plain text. */
function addedLines(note: Note, previous: Note | null): string[] {
  const old = new Set((previous?.body ?? "").split("\n").map((l) => l.trim()));
  return note.body.split("\n").map((l) => l.trim()).filter((l) => l && !old.has(l) && /[a-z]{3}/i.test(l)).map(stripMd);
}

export function SaveDetails({ report, note, index }: { report: WriteReport; note: Note; index: IndexState }) {
  const prev = report.previous;
  const changes = prev
    ? ([["title", "Title"], ["note_type", "Type"], ["visit_date", "Visit date"]] as const)
        .filter(([k]) => prev[k] !== note[k]).map(([k, label]) => ({ label, from: prev[k], to: note[k] }))
    : [];
  const bodyChanged = prev && prev.body !== note.body;

  return (
    <div className="mt-3 space-y-5 rounded-2xl border border-line bg-surface p-5 text-[13px]">
      <div>
        <p className="text-[15px] font-semibold text-ink">
          {report.kind === "update" ? "Updated an existing note" : "Inserted a new note"}{" "}
          <span className="font-normal text-slate">in the Supabase table</span>{" "}
          <span className="rounded-md bg-notes-soft px-1.5 py-px font-mono text-[12px] text-notes">{report.table}</span>
        </p>
        <p className="mt-1 text-slate">
          One {report.kind === "update" ? "UPDATE" : "INSERT"} statement, committed on its own. {report.rowsAffected} row
          {report.rowsAffected === 1 ? "" : "s"} affected; <code className="font-mono text-[12px]">updated_at</code> is now{" "}
          {new Date(report.updatedAt).toLocaleTimeString()}.
        </p>
      </div>

      {report.kind === "update" && (
        <Section title="What changed">
          {!changes.length && !bodyChanged ? (
            <p className="text-slate">Nothing differed from the stored version; the row was rewritten as is.</p>
          ) : (
            <ul className="space-y-1.5">
              {changes.map((c) => (
                <li key={c.label}>
                  <span className="font-medium text-ink-2">{c.label}:</span>{" "}
                  <span className="text-slate line-through">{c.from || "empty"}</span> → <span className="text-ink">{c.to}</span>
                </li>
              ))}
              {bodyChanged && (
                <li>
                  <span className="font-medium text-ink-2">Body:</span>{" "}
                  {prev!.body.length.toLocaleString()} → {note.body.length.toLocaleString()} characters
                  {addedLines(note, prev).slice(0, 3).map((l, i) => (
                    <span key={i} className="mt-1 block rounded-md bg-trials-soft px-2 py-1 text-[12.5px] text-ink-2">+ {l}</span>
                  ))}
                </li>
              )}
            </ul>
          )}
        </Section>
      )}

      <Section title="Where the time went">
        <Timing report={report} />
      </Section>

      <Section title="Search index">
        <SearchIndex index={index} />
      </Section>

      <Section title="What Postgres ran">
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded-xl bg-paper p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {report.sql}
        </pre>
        <p className="mt-2 text-[12px] leading-relaxed text-slate">
          Parameters are sent separately from the statement, so note text is never part of the SQL. Notes aren&apos;t
          indexed for search in this app: the copilot and the eligibility check read them straight from this table, so
          the new version is what they see on their next read.
        </p>
      </Section>
    </div>
  );
}

// The sync made visible: Postgres has the note the moment the save returns; turbopuffer catches up after indexing.
function SearchIndex({ index }: { index: IndexState }) {
  const ns = <span className="rounded-md bg-trials-soft px-1.5 py-px font-mono text-[12px] text-trials">match-notes</span>;
  return (
    <div className="space-y-1.5">
      <p className="text-ink-2">
        {index.state === "indexed" && <>Searchable in turbopuffer {ns} <span className="font-semibold tabular-nums text-ink">{secs(index.seconds)}</span> after the save returned.</>}
        {index.state === "waiting" && (index.seconds > 10
          ? <>Waiting to be indexed in {ns}. The once-a-minute sweep retries it{index.error ? ` (last error: ${index.error})` : ""}.</>
          : <>Indexing in {ns}…</>)}
        {index.state === "unknown" && <>Index status isn&apos;t available.</>}
      </p>
      <p className="text-[12px] leading-relaxed text-slate">
        Postgres reads see the new version at once. Search sees it after the app copies the note into turbopuffer, which
        embeds it: right after this save, or within a minute if that copy failed. Until then, a search returns the
        previous version.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate">{title}</h3>
      {children}
    </div>
  );
}

// Two steps, both measured from the app server, so each includes the round trip to Supabase.
function Timing({ report: r }: { report: WriteReport }) {
  const parts = [
    { label: "Read previous version", ms: r.readMs, color: "bg-line-2" },
    { label: r.kind === "update" ? "UPDATE" : "INSERT", ms: r.writeMs, color: "bg-ink" },
  ];
  const total = parts.reduce((a, p) => a + p.ms, 0) || 1;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-paper" role="img"
        aria-label={parts.map((p) => `${p.label} ${ms(p.ms)}`).join(", ")}>
        {parts.map((p) => <div key={p.label} className={p.color} style={{ width: `${Math.max(1.5, (p.ms / total) * 100)}%` }} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
        {parts.map((p) => (
          <li key={p.label} className="inline-flex items-center gap-1.5">
            <span className={cx("size-2 rounded-full", p.color)} aria-hidden />
            <span className="text-slate">{p.label}</span> <span className="font-semibold tabular-nums text-ink">{ms(p.ms)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] leading-relaxed text-slate">
        Both times include the network round trip from the app server to Supabase&apos;s connection pooler. A Postgres write
        is readable by the next query as soon as it commits.
      </p>
    </div>
  );
}
