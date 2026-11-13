#!/usr/bin/env node
// Apply the schema changes after the first migration: every supabase/migrations file from 0002 on, in order.
// 0001 (tables and the app role) is applied by `npm run setup-db`. Each later file is written to be safe to run again,
// so this can be re-run after adding one.
//
//   npm run migrate
//
// Environment (from `vercel env pull .env.local`): POSTGRES_URL_NON_POOLING, Supabase's direct admin connection.
import { readFileSync, readdirSync, existsSync } from "node:fs";
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
const ADMIN_URL = process.env.POSTGRES_URL_NON_POOLING || process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) { console.error("Set POSTGRES_URL_NON_POOLING (Supabase's direct admin connection string)."); process.exit(1); }

const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {}, ssl: process.env.PGSSL === "off" ? false : "require" });
try {
  const [{ exists }] = await sql`select to_regclass('public.patients') is not null as exists`;
  if (!exists) throw new Error("The tables don't exist yet. Run `npm run setup-db` first.");
  const dir = join(root, "supabase/migrations");
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f >= "0002").sort();
  for (const f of files) {
    await sql.unsafe(readFileSync(join(dir, f), "utf8"));
    console.log(`Applied ${f}`);
  }
  if (!files.length) console.log("No migrations after 0001.");
} finally {
  await sql.end();
}
