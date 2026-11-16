import { NextResponse } from "next/server";
import { NS } from "@/lib/config";
import { instanceInfo } from "@/lib/instance";
import { ensureLangfuse } from "@/lib/langfuse-setup";
import { requireUserId } from "@/lib/session";
import { namespaceCache } from "@/lib/tpuf";

export const dynamic = "force-dynamic";

/**
 * Warm-up before a search: the browser calls this when you focus a search box (at most once a minute). By the time you
 * press Search, the function instance is running, Langfuse's exporter has loaded and the connection to turbopuffer is
 * open. turbopuffer: ts-trials and ts-pubmed get a read-only cache check (this app never sends ts-* anything but reads;
 * tpCall treats hintCacheWarm as a write), and this app's own match-notes is asked to load into cache if it's cold.
 */
export async function POST() {
  const t0 = performance.now();
  const instance = instanceInfo();
  const user = await requireUserId();
  if (user instanceof Response) return user;
  const [, ...caches] = await Promise.all([
    ensureLangfuse(),
    ...[NS.trials, NS.pubmed, NS.notes].map((namespace) =>
      namespaceCache(namespace, namespace === NS.notes, "warm-check").then((c) => ({ namespace, ...c }),
        (e) => ({ namespace, state: "error", error: String((e as Error)?.message ?? e).slice(0, 160) }))),
  ]);
  const ms = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ warm: "done", cold: instance.cold, ageS: instance.ageS, ms, caches }));
  return NextResponse.json({ instance, ms, caches });
}
