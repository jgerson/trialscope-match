# Conventions for this repo

- This is a personal learning project. Keep the README's personal-project and not-for-clinical-use notes.
- Do not include Claude-Session links in commit messages or PR descriptions.
- Never commit keys. Settings come from environment variables (`.env.local` locally, Vercel project settings in production).
- `ts-trials` and `ts-pubmed` belong to the original TrialScope apps and are read only here (cache-warm hints are fine: they change no data). `scripts/setup-db.mjs` reads `ts-patients` once. Never write to those.
- Patient notes live in `ts-patient-<id>`, one namespace per patient, shared with trialscope-vercel and the Streamlit app: all of them read and write it. Keep its schema exactly as `lib/notes.ts` has it (`text` embedded with voyage-4-lite and BM25-indexed, `title`, `body`, `note_type`, `visit_date`, `author`); changing it here alone breaks the other apps. `tpCall` enforces the rules: reads and warm hints only on `ts-trials`, `ts-pubmed` and `ts-patient-*`, writes only on `ts-patient-*`. Don't widen these without asking.
- The structured patient record lives in Supabase Postgres. Schema changes go in a new file under `supabase/migrations/`. The app connects as `trialscope_app`, which can read, insert and update but not delete.
