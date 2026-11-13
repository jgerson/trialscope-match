#!/usr/bin/env node
// Schedule the notes-sync sweep in Supabase: once a minute, pg_cron runs a pg_net HTTP POST to /api/index-notes, which
// indexes any note still waiting (see lib/note-index.ts). Vercel's Hobby plan only runs its own cron jobs once a day,
// so the scheduler lives in the database instead.
//
//   npm run setup-index-cron -- https://your-app.example.com     schedule (or update) the job
//   npm run setup-index-cron -- --remove                          unschedule it
//
// The shared secret is stored in Supabase Vault and read by the job when it runs, so it never appears in cron.job.
// Environment (from .env.local): POSTGRES_URL_NON_POOLING (admin connection) and INDEX_NOTES_SECRET (the same value
// as on the Vercel project).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const JOB = "index-notes";
const VAULT_NAME = "index_notes_secret";
const remove = process.argv.includes("--remove");
const appUrl = process.argv.slice(2).find((a) => /^https:\/\//.test(a));
const ADMIN_URL = process.env.POSTGRES_URL_NON_POOLING || process.env.ADMIN_DATABASE_URL;
const SECRET = process.env.INDEX_NOTES_SECRET;
const fail = (m) => { console.error(m); process.exit(1); };
if (!ADMIN_URL) fail("Set POSTGRES_URL_NON_POOLING (Supabase's direct admin connection string).");
if (!remove && !appUrl) fail("Pass the app's https URL, e.g. npm run setup-index-cron -- https://your-app.example.com");
if (!remove && !SECRET) fail("Set INDEX_NOTES_SECRET in .env.local (the same value as on the Vercel project).");

const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {}, ssl: process.env.PGSSL === "off" ? false : "require" });
try {
  if (remove) {
    const r = await sql`select cron.unschedule(${JOB}) as removed`.catch(() => [{ removed: false }]);
    console.log(r[0].removed ? `Unscheduled ${JOB}.` : `No job named ${JOB}.`);
  } else {
    await sql`create extension if not exists pg_cron`;
    await sql`create extension if not exists pg_net with schema extensions`;
    // Store or replace the secret in Vault.
    const [existing] = await sql`select id from vault.secrets where name = ${VAULT_NAME}`;
    if (existing) await sql`select vault.update_secret(${existing.id}, ${SECRET})`;
    else await sql`select vault.create_secret(${SECRET}, ${VAULT_NAME}, 'Bearer token for the app''s /api/index-notes sweep')`;
    const endpoint = new URL("/api/index-notes", appUrl).toString();
    const command = `
      select net.http_post(
        url := '${endpoint.replace(/'/g, "''")}',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = '${VAULT_NAME}')),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000)`;
    // Scheduling by name replaces an existing job with the same name.
    await sql`select cron.schedule(${JOB}, '* * * * *', ${command})`;
    const [job] = await sql`select jobid, schedule, active from cron.job where jobname = ${JOB}`;
    console.log(`Scheduled ${JOB} (job ${job.jobid}, "${job.schedule}", active: ${job.active}) → POST ${endpoint}`);
  }
} finally {
  await sql.end();
}
