// Notes sync: copies notes from Supabase (the source of truth) into the turbopuffer namespace match-notes, so they can be
// searched across patients by keyword and by meaning.
//
// Supabase marks what needs indexing: a note is waiting when notes.indexed_at is null or older than updated_at
// (supabase/migrations/0002_note_search_index.sql). Every save sets updated_at, so a save marks its note in the same
// statement. This module indexes waiting notes and then sets indexed_at to the exact updated_at it sent, only where the
// note hasn't changed since: an edit that lands mid-index stays waiting and goes out on the next run.
//
// It runs right after each note save (the notes route schedules it with after()) and once a minute from
// /api/index-notes, which Supabase's pg_cron calls, to retry anything a save couldn't index. turbopuffer embeds the
// text itself (voyage-4-lite, like ts-trials), so there is no embedding step here. Upserts are idempotent, so a note
// indexed twice by both paths at once is harmless.
import "server-only";
import { config, NS } from "./config";
import { db, timed } from "./db";
import { tp } from "./tpuf";
import { tpCall } from "./tpuf-log";

// One row per note. text (title and body) is what BM25 and the embedding read; the rest are for filters and display.
const SCHEMA = {
  text: {
    type: "string",
    full_text_search: { language: "english", stemming: false, remove_stopwords: false, case_sensitive: false },
    embed: { model: config.embedModel, attribute: "embed_text" },
  },
  embed_text: { type: "[1024]f16", ann: { distance_metric: "cosine_distance" } },
  patient_id: { type: "string", filterable: true },
  note_type: { type: "string", filterable: true },
  visit_date: { type: "string", filterable: true },
  title: { type: "string", filterable: false },
  body: { type: "string", filterable: false },
  author: { type: "string", filterable: false },
} as const;

const BATCH = 100;

interface Waiting {
  id: string; patient_id: string; title: string; body: string; note_type: string; visit_date: string; author: string;
  // As text, so the exact microsecond value goes back into the "unchanged since" check.
  version: string;
}

export interface IndexRun { indexed: number; skipped: number; failed: number; waiting: number; ms: number; error?: string }

/**
 * Index notes that are waiting: the given ids (after a save), or the oldest waiting ones (the sweep). Returns how many
 * were indexed, how many changed again mid-run (left waiting), and how many are still waiting overall.
 */
export async function indexNotes(opts: { ids?: string[]; limit?: number } = {}): Promise<IndexRun> {
  const t0 = performance.now();
  const sql = db();
  const limit = Math.min(Math.max(opts.limit ?? BATCH, 1), BATCH);
  const rows = await timed("read-notes-to-index", () => sql<Waiting[]>`
    select id, patient_id, title, body, note_type, visit_date::text as visit_date, author, updated_at::text as version
    from notes
    where (indexed_at is null or indexed_at < updated_at) ${opts.ids?.length ? sql`and id = any(${opts.ids})` : sql``}
    order by updated_at limit ${limit}`);
  let indexed = 0, skipped = 0, failed = 0, error: string | undefined;
  if (rows.length) {
    const request = {
      upsert_rows: rows.map((n) => ({
        id: n.id, text: `${n.title}\n\n${n.body}`, patient_id: n.patient_id, note_type: n.note_type,
        visit_date: n.visit_date, title: n.title, body: n.body, author: n.author,
      })),
      distance_metric: "cosine_distance",
      schema: SCHEMA,
    };
    try {
      await tpCall("write", NS.notes, request,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => tp().namespace(NS.notes).write(request as any), { label: "index-notes" });
      // Versions travel as text and are cast in SQL: a timestamptz[] parameter would go through JavaScript Dates, which
      // drop the microseconds, and the "unchanged since" check would never match.
      const done = await timed("mark-notes-indexed", () => sql`
        update notes n set indexed_at = x.version::timestamptz, index_error = null, index_attempts = 0
        from unnest(${rows.map((r) => r.id)}::text[], ${rows.map((r) => r.version)}::text[]) as x(id, version)
        where n.id = x.id and n.updated_at = x.version::timestamptz`);
      indexed = done.count;
      skipped = rows.length - done.count;
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
      failed = rows.length;
      await timed("mark-notes-failed", () => sql`
        update notes set index_error = ${error!}, index_attempts = index_attempts + 1
        where id = any(${rows.map((r) => r.id)})`).catch(() => undefined);
    }
  }
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from notes where indexed_at is null or indexed_at < updated_at`;
  const run = { indexed, skipped, failed, waiting: n, ms: Math.round(performance.now() - t0), ...(error ? { error } : {}) };
  console.log(JSON.stringify({ noteIndex: opts.ids ? "after-save" : "sweep", ...run }));
  return run;
}

export interface IndexStatus { id: string; savedAt: string; indexedAt: string | null; indexed: boolean; error: string | null; attempts: number }

/** Where one note stands: saved at updated_at, and whether that version has reached turbopuffer yet. */
export async function noteIndexStatus(id: string, patientId: string): Promise<IndexStatus | null> {
  // Compared in SQL: JavaScript Dates would drop the microseconds.
  const rows = await db()<{ saved: Date; indexed_at: Date | null; current: boolean; index_error: string | null; index_attempts: number }[]>`
    select updated_at as saved, indexed_at, coalesce(indexed_at >= updated_at, false) as current, index_error, index_attempts
    from notes where id = ${id} and patient_id = ${patientId}`;
  const r = rows[0];
  if (!r) return null;
  return {
    id, savedAt: new Date(r.saved).toISOString(), indexedAt: r.indexed_at ? new Date(r.indexed_at).toISOString() : null,
    indexed: r.current, error: r.index_error, attempts: r.index_attempts,
  };
}
