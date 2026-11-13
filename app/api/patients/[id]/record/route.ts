import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { changeRecord, getRecord } from "@/lib/patients";
import { dbMessage, InputError, parseChange } from "@/lib/record-input";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const record = await getRecord((await params).id);
  return record ? NextResponse.json(record) : NextResponse.json({ error: "Unknown patient." }, { status: 404 });
}

/** Apply one change (edit demographics, add or update a condition, add or stop a medication, add a result). */
export async function POST(req: Request, { params }: Ctx) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (config.readOnly) return NextResponse.json({ error: "Editing is turned off on this deployment." }, { status: 403 });
  const { id } = await params;
  try {
    const change = parseChange((await req.json()) as Record<string, unknown>);
    const { record, ms } = await changeRecord(id, change);
    console.log(JSON.stringify({ record: change.op, patientId: id, ms: Math.round(ms) }));
    return NextResponse.json({ record, ms: Math.round(ms) });
  } catch (e) {
    if (e instanceof InputError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: dbMessage(e) }, { status: 502 });
  }
}
