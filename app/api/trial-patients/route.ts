// "Find patients for this trial": the trial's criteria as rules (one model call per trial, cached in Supabase), then
// one SQL query that scores every patient on every rule. GET /api/trial-patients?nct=NCT01234567
import { after, NextResponse } from "next/server";
import { startActiveObservation } from "@langfuse/tracing";
import { copilotEnabled } from "@/lib/config";
import { getTrial, NCT_RE } from "@/lib/ctgov";
import { flushLangfuse, newTrace } from "@/lib/langfuse";
import { requireUserId } from "@/lib/session";
import { matchPatients, ruleLabel } from "@/lib/trial-match";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (!copilotEnabled) return NextResponse.json({ error: "The AI checks are off on this deployment." }, { status: 503 });
  const nct = (new URL(req.url).searchParams.get("nct") ?? "").toUpperCase();
  if (!NCT_RE.test(nct)) return NextResponse.json({ error: "Unknown trial id." }, { status: 400 });

  // One Langfuse trace per lookup (tagged "trial-patients"): the rule extraction when it isn't cached, then the query.
  after(flushLangfuse);
  try {
    const out = await newTrace({ userId: user, tags: ["trial-patients"], metadata: { nct } }, () =>
      startActiveObservation("find-trial-patients", async (obs) => {
        obs.update({ input: { nct } });
        const trial = await getTrial(nct);
        if (!trial) return null;
        const m = await matchPatients(trial);
        obs.update({ output: { rules: m.rules.rules.length, cached: m.rules.cached, candidates: m.candidates.length,
          excluded: m.excluded.length, sqlMs: m.sql.ms, rulesMs: m.rules.ms } });
        return m;
      }, { asType: "chain" }));
    if (!out) return NextResponse.json({ error: "ClinicalTrials.gov has no such study." }, { status: 404 });
    console.log(JSON.stringify({ trialPatients: nct, rules: out.rules.rules.length, cached: out.rules.cached,
      candidates: out.candidates.length, excluded: out.excluded.length, rulesMs: out.rules.ms, sqlMs: out.sql.ms }));
    return NextResponse.json({ ...out, labels: out.rules.rules.map(ruleLabel) });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't match patients: ${(e as Error).message}` }, { status: 502 });
  }
}
