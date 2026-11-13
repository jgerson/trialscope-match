import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { indexNotes } from "@/lib/note-index";
import { getPatient, noteAuthor, saveNote } from "@/lib/patients";
import { displayName, requireUserId } from "@/lib/session";
import type { Note } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (config.readOnly) return NextResponse.json({ error: "Editing is turned off on this deployment." }, { status: 403 });
  const { patientId, note } = (await req.json()) as { patientId: string; note: Partial<Note> };
  if (!(await getPatient(patientId))) return NextResponse.json({ error: "Unknown patient." }, { status: 404 });
  // An edit must name one of this patient's existing notes; anything else is a new note with an id the server picks,
  // so a client can't choose ids (turbopuffer limits them to 64 bytes) or claim another patient's note.
  const existingAuthor = note.id ? await noteAuthor(String(note.id), patientId) : null;
  const clean: Note = {
    id: existingAuthor != null ? String(note.id) : `${patientId}-${randomUUID().slice(0, 8)}`,
    title: (note.title ?? "").trim().slice(0, 200) || "Untitled note",
    body: (note.body ?? "").slice(0, 20000),
    note_type: note.note_type || "Visit note",
    visit_date: note.visit_date || new Date().toISOString().slice(0, 10),
    // A new note is credited to whoever is signed in. An edit keeps the author stored in Postgres, not one the client sends.
    author: existingAuthor ?? (await displayName()),
  };
  // One Langfuse trace per save (tagged "notes"): the read of the previous version and the insert or update in Postgres.
  after(flushLangfuse);
  try {
    const res = await newTrace({ userId: user, tags: ["notes"], metadata: { patientId } }, () =>
      startActiveObservation("save-note", async (obs) => {
        obs.update({ input: { patientId, id: clean.id, title: clean.title, note_type: clean.note_type,
          visit_date: clean.visit_date, bodyChars: clean.body.length } });
        const r = await saveNote(patientId, clean);
        obs.update({ output: { kind: r.kind, table: r.table, readMs: Math.round(r.readMs), writeMs: Math.round(r.writeMs),
          rowsAffected: r.rowsAffected } });
        return r;
      }, { asType: "span" }));
    console.log(JSON.stringify({ note: res.kind, table: res.table, id: res.id, writeMs: Math.round(res.writeMs) }));
    // Copy the saved version into turbopuffer once the response has gone out. If this fails, the note stays marked as
    // waiting in Postgres and the once-a-minute sweep (/api/index-notes) retries it.
    after(() => indexNotes({ ids: [res.id] }).catch((e) =>
      console.log(JSON.stringify({ noteIndex: "after-save", id: res.id, error: (e as Error).message.slice(0, 300) }))));
    return NextResponse.json({ note: clean, ...res });
  } catch (e) {
    return NextResponse.json({ error: `Save failed: ${(e as Error).message}` }, { status: 502 });
  }
}
