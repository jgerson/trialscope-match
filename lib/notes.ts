// Patient notes, in turbopuffer: one namespace per patient, ts-patient-<id>, shared with the original TrialScope apps
// (trialscope.space and the Streamlit app), with the same schema they use. Reading, listing and saving all happen there;
// a saved note is searchable as soon as the write returns. The structured record (patients, conditions, medications,
// labs) stays in Supabase (lib/patients.ts).
import "server-only";
import { config, NS } from "./config";
import { tp } from "./tpuf";
import { tpCall } from "./tpuf-log";
import type { Note, WriteReport } from "./types";

type Row = Record<string, unknown> & { id: string | number };

const FIELDS = ["title", "body", "note_type", "visit_date", "author"];

// The schema every app writes to ts-patient-* with. Don't change it here alone: trialscope.space and the Streamlit
// app read and write the same namespaces.
const NOTE_SCHEMA = {
  text: { type: "string", full_text_search: true, embed: config.embedModel },
  title: { type: "string", filterable: false },
  body: { type: "string", filterable: false },
  note_type: { type: "string" },
  visit_date: { type: "string" },
  author: { type: "string" },
};

// How each note attribute is stored, in words, for the save panel. Mirrors NOTE_SCHEMA.
const NOTE_STORAGE: WriteReport["schema"] = [
  { field: "text", stored: `title + body: keyword-indexed (BM25) and embedded by turbopuffer with ${config.embedModel}` },
  { field: "title", stored: "stored for display, not filterable" },
  { field: "body", stored: "stored for display, not filterable" },
  { field: "note_type", stored: "filterable" },
  { field: "visit_date", stored: "filterable" },
  { field: "author", stored: "filterable" },
];

const toNote = (r: Row): Note => ({
  id: String(r.id), title: String(r.title ?? ""), body: String(r.body ?? ""), note_type: String(r.note_type ?? ""),
  visit_date: String(r.visit_date ?? ""), author: String(r.author ?? ""),
});

/** This patient's notes, newest visit first. A patient with no namespace yet has no notes. */
export async function listNotes(patientId: string): Promise<Note[]> {
  const namespace = NS.patient(patientId);
  const req = { rank_by: ["visit_date", "desc"], top_k: 200, include_attributes: FIELDS };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tpCall("query", namespace, req, () => tp().namespace(namespace).query(req as any), { label: "list-notes" });
    return ((res.rows ?? []) as Row[]).map(toNote);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return [];
    throw e;
  }
}

/** One of this patient's notes, or null when there's no note with that id in their namespace. */
async function readNote(patientId: string, id: string, label: string): Promise<Note | null> {
  const namespace = NS.patient(patientId);
  const req = { filters: ["id", "Eq", id], top_k: 1, include_attributes: FIELDS };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tpCall("query", namespace, req, () => tp().namespace(namespace).query(req as any), { label });
    const r = res.rows?.[0] as Row | undefined;
    return r ? toNote(r) : null;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/** The stored author of one of this patient's notes, or null when the patient has no note with that id. */
export async function noteAuthor(id: string, patientId: string): Promise<string | null> {
  return (await readNote(patientId, id, "read-note-author"))?.author ?? null;
}

/** Upsert one note and report what happened: insert or update, turbopuffer's write report, and when it became visible. */
export async function saveNote(patientId: string, note: Note): Promise<WriteReport & { id: string }> {
  const namespace = NS.patient(patientId);
  const ns = tp().namespace(namespace);

  // The current version, if any: an upsert replaces by id, so this decides insert vs update and feeds the diff.
  const tr = performance.now();
  const previous = await readNote(patientId, note.id, "read-previous-note");
  const readMs = performance.now() - tr;

  const row = { ...note, text: `${note.title}\n${note.body}` };
  const t0 = performance.now();
  const writeReq = { upsert_rows: [row], schema: NOTE_SCHEMA, distance_metric: "cosine_distance" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tpCall("write", namespace, writeReq, () => ns.write(writeReq as any), { label: "write-note" });
  const writeMs = performance.now() - t0;

  // Queries are strongly consistent by default, so a fresh write should be visible straight away. Logged as one record
  // with the number of attempts, not one line per poll.
  const t1 = performance.now();
  const visReq = { filters: ["id", "Eq", note.id], top_k: 1, include_attributes: ["title"] };
  await tpCall("query", namespace, visReq, async () => {
    let attempts = 0;
    let found = false;
    for (; attempts < 20 && !found; attempts++) {
      if (attempts) await new Promise((r) => setTimeout(r, 50));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = await ns.query(visReq as any);
      found = Boolean(q.rows?.length);
    }
    return { attempts, found };
  }, { label: "wait-until-visible", extra: (r) => r });
  const visibleMs = performance.now() - t1;

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const short = (t: string) => (t.length > 600 ? `${t.slice(0, 600)}… (${t.length.toLocaleString()} characters)` : t);
  return {
    id: note.id, namespace, kind: previous ? "update" : "insert", previous,
    row: { id: note.id, title: note.title, body: short(note.body), note_type: note.note_type, visit_date: note.visit_date,
      author: note.author, text: short(row.text) },
    bodyChars: note.body.length, schema: NOTE_STORAGE, readMs, writeMs, visibleMs,
    serverMs: num(res?.performance?.server_total_ms), embeddingMs: num(res?.performance?.embedding_ms),
    embeddingTokens: num(res?.performance?.embedding_tokens), rowsAffected: num(res?.rows_affected),
    rowsUpserted: num(res?.rows_upserted), billableBytes: num(res?.billing?.billable_logical_bytes_written),
  };
}
