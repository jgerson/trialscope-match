// The notes-sync sweep: indexes every note still waiting (new, edited, or failed after a save) into turbopuffer.
// Called once a minute by Supabase's pg_cron through pg_net (see scripts/setup-index-cron.mjs), with
// Authorization: Bearer $INDEX_NOTES_SECRET. It's outside Clerk sign-in (proxy.ts), so the secret is the only way in.
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { indexNotes } from "@/lib/note-index";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Five batches of 100 per call is far more than a minute's edits; a large backfill finishes over a few calls.
const MAX_BATCHES = 5;

// Compare SHA-256 digests: always 32 bytes each, so the comparison can't throw on odd input (a non-ASCII header is a
// different byte length than its character count) and the time taken doesn't reveal the secret's length.
const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

function authorized(req: Request): boolean {
  const secret = config.indexNotesSecret;
  if (!secret) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return timingSafeEqual(digest(got), digest(secret));
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const runs = [];
  for (let i = 0; i < MAX_BATCHES; i++) {
    const run = await indexNotes();
    runs.push(run);
    // Stop when nothing is left, or when a batch failed (turbopuffer down): the next minute's call retries.
    if (!run.waiting || run.failed || !run.indexed) break;
  }
  const total = runs.reduce((a, r) => ({ indexed: a.indexed + r.indexed, failed: a.failed + r.failed }), { indexed: 0, failed: 0 });
  return NextResponse.json({ ...total, waiting: runs.at(-1)?.waiting ?? 0, batches: runs.length, error: runs.find((r) => r.error)?.error });
}
