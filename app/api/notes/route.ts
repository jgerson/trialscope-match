import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { getPatient, saveNote } from "@/lib/patients";
import { displayName, requireUserId } from "@/lib/session";
import type { Note } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (config.readOnly) return NextResponse.json({ error: "Editing is turned off on this deployment." }, { status: 403 });
  const { patientId, note } = (await req.json()) as { patientId: string; note: Partial<Note> };
  if (!(await getPatient(patientId))) return NextResponse.json({ error: "Unknown patient." }, { status: 404 });
  const clean: Note = {
    id: note.id || `${patientId}-${randomUUID().slice(0, 8)}`,
    title: (note.title ?? "").trim().slice(0, 200) || "Untitled note",
    body: (note.body ?? "").slice(0, 20000),
    note_type: note.note_type || "Visit note",
    visit_date: note.visit_date || new Date().toISOString().slice(0, 10),
    // A new note is credited to whoever is signed in. An edit keeps the note's original author.
    author: note.id ? note.author || (await displayName()) : await displayName(),
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
    return NextResponse.json({ note: clean, ...res });
  } catch (e) {
    return NextResponse.json({ error: `Save failed: ${(e as Error).message}` }, { status: 502 });
  }
}
