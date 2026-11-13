// Search across all patients (the bar at the top of the patient workspace): by notes in turbopuffer, by record
// attributes in Supabase, or both. GET returns the values that exist in the data, for the filter suggestions.
import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { cleanFilters, filterOptions, searchPatients, type SearchMode } from "@/lib/patient-search";
import { requireUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

const MODES: SearchMode[] = ["notes", "attributes", "both"];

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const body = (await req.json()) as { q?: string; mode?: string; filters?: unknown };
  const mode = (MODES.includes(body.mode as SearchMode) ? body.mode : "both") as SearchMode;
  const q = String(body.q ?? "").trim().slice(0, 300);
  const filters = mode === "notes" ? [] : cleanFilters(body.filters);
  if (mode === "notes" && !q) return NextResponse.json({ error: "Type what to look for in the notes." }, { status: 400 });
  if (mode === "attributes" && !filters.length) return NextResponse.json({ error: "Add at least one filter." }, { status: 400 });
  if (mode === "both" && !q && !filters.length) return NextResponse.json({ error: "Type a search or add a filter." }, { status: 400 });

  // One Langfuse trace per search (tagged "patient-search"), with the turbopuffer call nested under it.
  after(flushLangfuse);
  try {
    const res = await newTrace({ userId: user, tags: ["patient-search"], metadata: { mode } }, () =>
      startActiveObservation("search-patients", async (obs) => {
        obs.update({ input: { q, mode, filters } });
        const out = await searchPatients(mode, q, filters);
        obs.update({ output: { patients: out.patients.length, supabase: out.supabase && { ms: out.supabase.ms, matched: out.supabase.matched },
          turbopuffer: out.turbopuffer && { ms: out.turbopuffer.ms, notes: out.turbopuffer.notesReturned } } });
        return out;
      }, { asType: "chain" }));
    console.log(JSON.stringify({ patientSearch: mode, filters: filters.length, text: !!q, patients: res.patients.length,
      pgMs: res.supabase?.ms, tpufMs: res.turbopuffer?.ms }));
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json({ error: `Search failed: ${(e as Error).message}` }, { status: 502 });
  }
}

export async function GET() {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  return NextResponse.json(await filterOptions(), { headers: { "Cache-Control": "private, max-age=300" } });
}
