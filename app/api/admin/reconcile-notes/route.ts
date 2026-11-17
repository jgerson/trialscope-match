// TEMPORARY (one-time migration; delete after it has run). Copies notes that exist only in Supabase into each
// patient's turbopuffer namespace (ts-patient-<id>), the one the original TrialScope apps already use, so Supabase's
// notes table can be retired. Signed-in users only.
//   GET /api/admin/reconcile-notes          dry run: what differs, per patient
//   GET /api/admin/reconcile-notes?apply=1  write the differences, then re-check
// A note is written when its id is missing from the namespace or any field differs. Nothing is deleted anywhere.
import { NextResponse } from "next/server";
import { config, NS } from "@/lib/config";
import { db } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import { tp } from "@/lib/tpuf";
import { tpCall } from "@/lib/tpuf-log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Exactly the schema trialscope.space writes (its lib/tpuf.ts NOTE_SCHEMA), so the shared namespaces stay compatible.
const NOTE_SCHEMA = {
  text: { type: "string", full_text_search: true, embed: config.embedModel },
  title: { type: "string", filterable: false },
  body: { type: "string", filterable: false },
  note_type: { type: "string" },
  visit_date: { type: "string" },
  author: { type: "string" },
};
const FIELDS = ["title", "body", "note_type", "visit_date", "author"] as const;
type Note = { id: string; patient_id: string } & Record<(typeof FIELDS)[number], string>;

async function namespaceNotes(patientId: string): Promise<Map<string, Record<string, string>>> {
  const namespace = NS.patient(patientId);
  const req = { rank_by: ["visit_date", "desc"], top_k: 1000, include_attributes: [...FIELDS] };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await tpCall("query", namespace, req, () => tp().namespace(namespace).query(req as any), { label: "reconcile-read" });
    return new Map((res.rows ?? []).map((r: Record<string, unknown>) =>
      [String(r.id), Object.fromEntries(FIELDS.map((f) => [f, String(r[f] ?? "")]))]));
  } catch (e) {
    if ((e as { status?: number }).status === 404) return new Map(); // no namespace yet: every note is missing
    throw e;
  }
}

async function diff() {
  const notes = await db()<Note[]>`
    select id, patient_id, title, body, note_type, visit_date::text as visit_date, author from notes order by patient_id, id`;
  const byPatient = new Map<string, Note[]>();
  for (const n of notes) byPatient.set(n.patient_id, [...(byPatient.get(n.patient_id) ?? []), n]);
  const patients = await Promise.all([...byPatient.entries()].map(async ([patientId, rows]) => {
    const inTpuf = await namespaceNotes(patientId);
    const missing = rows.filter((n) => !inTpuf.has(n.id));
    const changed = rows.filter((n) => inTpuf.has(n.id) && FIELDS.some((f) => String(n[f] ?? "") !== inTpuf.get(n.id)![f]));
    const onlyInTpuf = [...inTpuf.keys()].filter((id) => !rows.some((n) => n.id === id));
    return { patientId, namespace: NS.patient(patientId), supabase: rows.length, turbopuffer: inTpuf.size,
      missing, changed, onlyInTpuf };
  }));
  return { supabaseNotes: notes.length, patients };
}

const summary = (d: Awaited<ReturnType<typeof diff>>) => ({
  supabaseNotes: d.supabaseNotes,
  patients: d.patients.length,
  toWrite: d.patients.reduce((n, p) => n + p.missing.length + p.changed.length, 0),
  differing: d.patients.filter((p) => p.missing.length || p.changed.length).map((p) => ({
    patientId: p.patientId, supabase: p.supabase, turbopuffer: p.turbopuffer,
    missing: p.missing.map((n) => n.id), changed: p.changed.map((n) => n.id) })),
  onlyInTurbopuffer: d.patients.filter((p) => p.onlyInTpuf.length).map((p) => ({ patientId: p.patientId, ids: p.onlyInTpuf })),
});

export async function GET(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const apply = new URL(req.url).searchParams.get("apply") === "1";
  try {
    const before = await diff();
    if (!apply) return NextResponse.json({ dryRun: true, ...summary(before) });
    const written: { patientId: string; rows: number }[] = [];
    for (const p of before.patients) {
      const rows = [...p.missing, ...p.changed].map((n) => ({
        id: n.id, title: n.title, body: n.body, note_type: n.note_type, visit_date: n.visit_date, author: n.author,
        text: `${n.title}\n${n.body}`,
      }));
      if (!rows.length) continue;
      const writeReq = { upsert_rows: rows, schema: NOTE_SCHEMA, distance_metric: "cosine_distance" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await tpCall("write", p.namespace, writeReq, () => tp().namespace(p.namespace).write(writeReq as any), { label: "reconcile-write" });
      written.push({ patientId: p.patientId, rows: rows.length });
    }
    const after = await diff();
    return NextResponse.json({ applied: true, written, after: summary(after) });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message ?? e).slice(0, 500) }, { status: 500 });
  }
}
