// Whether a note's saved version has reached turbopuffer yet. The note's Details panel polls this after a save to show
// how long the note took to become searchable.
import { NextResponse } from "next/server";
import { noteIndexStatus } from "@/lib/note-index";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const patientId = url.searchParams.get("patientId") ?? "";
  if (!id || !patientId) return NextResponse.json({ error: "Pass id and patientId." }, { status: 400 });
  const status = await noteIndexStatus(id, patientId);
  if (!status) return NextResponse.json({ error: "Unknown note." }, { status: 404 });
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
