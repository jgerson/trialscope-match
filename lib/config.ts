// Server-side settings. Read from environment variables (Vercel project settings or .env.local).
import "server-only";

export const config = {
  tpufKey: process.env.TURBOPUFFER_API_KEY ?? "",
  tpufRegion: process.env.TURBOPUFFER_REGION ?? "aws-us-east-1",
  // Supabase Postgres, connected as the trialscope_app role through the pooler (transaction mode, port 6543).
  databaseUrl: process.env.APP_DATABASE_URL ?? "",
  // Copilot: an ANTHROPIC_API_KEY calls Anthropic directly. Without one, calls go through Vercel AI Gateway,
  // authenticated by AI_GATEWAY_API_KEY or, on Vercel (and locally after `vercel env pull`), the project's OIDC token.
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  gatewayKey: process.env.AI_GATEWAY_API_KEY ?? "",
  onVercel: Boolean(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN),
  copilotModel:
    process.env.COPILOT_MODEL ?? (process.env.ANTHROPIC_API_KEY ? "claude-sonnet-5-5" : "anthropic/claude-sonnet-5.5"),
  // READ_ONLY=true turns off every edit in the UI (notes and patient records).
  readOnly: ["1", "true", "yes"].includes((process.env.READ_ONLY ?? "").toLowerCase()),
  // Anthropic prompt caching for the copilot (COPILOT_PROMPT_CACHE=true). Each model call in a question re-sends the
  // system prompt, tools and earlier turns; cached, those cost a fraction of the input price on the next call.
  promptCache: ["1", "true", "yes"].includes((process.env.COPILOT_PROMPT_CACHE ?? "").toLowerCase()),
  embedModel: "voyage/voyage-4-lite",
  // Shared secret for /api/index-notes, the once-a-minute indexing sweep that Supabase's pg_cron calls.
  indexNotesSecret: process.env.INDEX_NOTES_SECRET ?? "",
};

export const copilotEnabled = Boolean(config.anthropicKey || config.gatewayKey || config.onVercel);

// turbopuffer namespaces. ts-trials and ts-pubmed are the original TrialScope app's shared corpora, read only.
// match-notes is this app's own: every note, synced from Supabase (lib/note-index.ts), with patient_id as a filter.
// Patients and notes themselves live in Supabase (see lib/patients.ts).
export const NS = {
  prefix: "ts-",
  trials: "ts-trials",
  pubmed: "ts-pubmed",
  notes: "match-notes",
};

export const RRF_K = 60;
