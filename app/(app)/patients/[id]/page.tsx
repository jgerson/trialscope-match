import { notFound } from "next/navigation";
import { Workspace } from "@/components/workspace";
import { getPatient, getRecord, listNotes } from "@/lib/patients";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const p = await getPatient((await params).id);
  return { title: p?.name ?? "Patient" };
}

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The structured record (Supabase) and the notes (turbopuffer, ts-patient-<id>), in parallel.
  const t0 = performance.now();
  const [record, notes] = await Promise.all([getRecord(id), listNotes(id)]);
  if (!record) notFound();
  const loadMs = Math.round(performance.now() - t0);
  return <Workspace patient={record.patient} initialRecord={record} initialNotes={notes} loadMs={loadMs} />;
}
