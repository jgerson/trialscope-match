// Supabase Postgres access. Every query in the app goes through sql`` from here, timed with timed() so the UI and the
// copilot can say which database answered and how long it took.
import "server-only";
import postgres from "postgres";
import { config } from "./config";

let _sql: postgres.Sql | null = null;

/**
 * One client per server instance. The URL is Supabase's pooler in transaction mode (port 6543), which doesn't keep
 * prepared statements between transactions, so they're turned off. A handful of connections is plenty for serverless.
 */
export function db(): postgres.Sql {
  if (!config.databaseUrl) throw new Error("APP_DATABASE_URL is not set");
  _sql ??= postgres(config.databaseUrl, {
    prepare: false,
    max: 5,
    // Opening a connection (TCP, SSL and auth at the pooler) costs about 100 ms, while a query on an open one takes
    // about 5 ms. Keep idle connections for 5 minutes so a page load after a pause doesn't reconnect; Supavisor holds
    // idle client connections cheaply.
    idle_timeout: 300,
    connect_timeout: 10,
    // Supabase can require SSL for every role, and the URL setup-db prints has no sslmode, so ask for it here
    // (PGSSL=off for a local Postgres without SSL, as in setup-db).
    ssl: process.env.PGSSL === "off" ? false : "require",
    // Dates come back as YYYY-MM-DD strings, the format the UI and the trials data already use.
    types: { date: { to: 1082, from: [1082], serialize: (v: string) => v, parse: (v: string) => v } },
  });
  return _sql;
}

export interface QueryTiming { label: string; ms: number; rows: number }

/** Run one query and record how long it took; one JSON line per query in the runtime logs, like the turbopuffer calls. */
export async function timed<T extends readonly unknown[]>(label: string, run: () => Promise<T>,
  log?: QueryTiming[]): Promise<T> {
  const t0 = performance.now();
  try {
    const rows = await run();
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    log?.push({ label, ms, rows: rows.length });
    console.log(JSON.stringify({ postgres: label, ms, rows: rows.length }));
    return rows;
  } catch (e) {
    console.log(JSON.stringify({ postgres: label, ms: Math.round(performance.now() - t0), error: (e as Error).message }));
    throw e;
  }
}
