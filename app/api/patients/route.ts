import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { createPatient } from "@/lib/patients";
import { dbMessage, InputError, parseNewPatient } from "@/lib/record-input";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Create a patient and their primary diagnosis in one Postgres transaction. */
export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (config.readOnly) return NextResponse.json({ error: "Editing is turned off on this deployment." }, { status: 403 });
  try {
    const input = parseNewPatient((await req.json()) as Record<string, unknown>);
    const t0 = performance.now();
    const patient = await createPatient(input);
    return NextResponse.json({ patient, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    if (e instanceof InputError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: dbMessage(e) }, { status: 502 });
  }
}
