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
};

export const copilotEnabled = Boolean(config.anthropicKey || config.gatewayKey || config.onVercel);

// The original TrialScope app's turbopuffer namespaces. This app only reads the two shared corpora; patients and their
// notes live in Supabase (see lib/patients.ts).
export const NS = {
  prefix: "ts-",
  trials: "ts-trials",
  pubmed: "ts-pubmed",
};

export const RRF_K = 60;
