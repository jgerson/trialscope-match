# Conventions for this repo

- This is a personal learning project. Keep the README's personal-project and not-for-clinical-use notes.
- Do not include Claude-Session links in commit messages or PR descriptions.
- Never commit keys. Settings come from environment variables (`.env.local` locally, Vercel project settings in production).
- The turbopuffer namespaces (`ts-trials`, `ts-pubmed`, `ts-patients`, `ts-patient-*`) belong to the original TrialScope apps. This app only reads `ts-trials` and `ts-pubmed` at runtime (enforced in `tpCall`), and `scripts/setup-db.mjs` only reads `ts-patients` and `ts-patient-*` once. Never write to turbopuffer from this repo.
- Patient data lives in Supabase Postgres. Schema changes go in a new file under `supabase/migrations/`. The app connects as `trialscope_app`, which can read, insert and update but not delete.
