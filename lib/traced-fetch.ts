// A fetch that records each outgoing HTTP call as a span in Langfuse, nested under whatever is running (a turbopuffer
// step, a model call, a ClinicalTrials.gov read). It's passed to the turbopuffer and Anthropic clients and used for
// ClinicalTrials.gov, so a trace shows network time next to each service's own timings. Outside a trace, or without
// Langfuse keys, it's plain fetch.
//
// Recorded: method, host, path, status, time until the response headers arrived, and request and response sizes.
// For turbopuffer reads, also the full URL, the JSON request body and the JSON response body, so one span is the exact
// call and what came back (paste the request into curl with your own key). In response bodies long strings are cut to
// 300 characters, and for a patient's notes namespace (ts-patient-*) the note text (title, body, text) is left out:
// ids, scores, note types, dates and timings stay. Never recorded: headers (they hold keys), query strings, response
// bodies from any other host or from writes, any request body sent elsewhere (model prompts carry patient text), and
// turbopuffer write bodies (their rows can hold patient notes).
import "server-only";
import { startObservation } from "@langfuse/tracing";
import { langfuseEnabled, langfuseReady } from "./langfuse-setup";
import { insideTrace } from "./langfuse";

export const tracedFetch: typeof fetch = async (input, init) => {
  if (!langfuseEnabled || !langfuseReady() || !insideTrace()) return fetch(input, init);
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return fetch(input, init);
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const requestBytes = typeof init?.body === "string" ? init.body.length : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let span: any;
  try {
    span = startObservation(`http ${method} ${url.host}`, {
      input: { method, host: url.host, path: url.pathname, ...tpufRequest(url, init?.body) },
      metadata: { kind: "http", method, host: url.host, path: url.pathname, requestBytes },
    }, { asType: "span" });
  } catch {
    return fetch(input, init); // tracing must never break the request
  }
  const t0 = performance.now();
  try {
    const res = await fetch(input, init);
    const ms = Math.round(performance.now() - t0);
    const len = Number(res.headers.get("content-length"));
    // A turbopuffer read's JSON response, read from a clone so the caller's body is untouched. The span ends once
    // it's read (a few ms); `ms` stays the time to response headers.
    const body = await tpufResponse(url, init?.body, res);
    safe(() => span.update({
      output: { status: res.status, ms, ...(body !== undefined ? { body } : {}) },
      // For a streamed response (the copilot's model calls) this is time to first byte; the stream continues after.
      metadata: { status: res.status, ms, responseBytes: Number.isFinite(len) && len > 0 ? len : undefined,
        streamed: (res.headers.get("content-type") ?? "").includes("event-stream") },
      ...(res.ok ? {} : { level: res.status >= 500 ? "ERROR" : "WARNING", statusMessage: `HTTP ${res.status}` }),
    }).end());
    return res;
  } catch (e) {
    safe(() => span.update({ level: "ERROR", statusMessage: String((e as Error)?.message ?? e).slice(0, 300) }).end());
    throw e;
  }
};

const TPUF_HOST = /(^|\.)turbopuffer\.com$/;
// Request keys that make a turbopuffer call a write; their bodies are never recorded.
const WRITE_KEYS = ["upsert_rows", "upsert_columns", "patch_rows", "patch_columns", "deletes", "delete_by_filter",
  "patch_by_filter", "copy_from_namespace"];
const MAX_BODY_CHARS = 16_000;

/** For a turbopuffer call: the full URL and, for a read, its JSON body. Nothing for any other host. */
function tpufRequest(url: URL, body: unknown): { url?: string; body?: unknown } {
  if (!TPUF_HOST.test(url.host)) return {};
  const full = { url: `${url.origin}${url.pathname}` };
  if (typeof body !== "string" || !body) return full;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return full;
  }
  if (json && typeof json === "object" && WRITE_KEYS.some((k) => k in json)) {
    return { ...full, body: { omitted: "write request (rows can hold patient notes)" } };
  }
  if (body.length > MAX_BODY_CHARS) return { ...full, body: { omitted: `request body over ${MAX_BODY_CHARS} characters`, chars: body.length } };
  return { ...full, body: json };
}

const MAX_RESPONSE_CHARS = 48_000;
const MAX_STRING = 300;
// Attributes that hold a patient's note text in ts-patient-* (see lib/notes.ts).
const NOTE_TEXT = new Set(["title", "body", "text"]);

/** For a turbopuffer read with a JSON response: the response body, slimmed. Undefined for anything else. */
async function tpufResponse(url: URL, reqBody: unknown, res: Response): Promise<unknown> {
  if (!TPUF_HOST.test(url.host)) return undefined;
  if (!(res.headers.get("content-type") ?? "").includes("json")) return undefined;
  if (typeof reqBody === "string" && reqBody) {
    try {
      const json = JSON.parse(reqBody);
      if (json && typeof json === "object" && WRITE_KEYS.some((k) => k in json)) return undefined;
    } catch {
      // not JSON: treat as a read
    }
  }
  try {
    const parsed = JSON.parse(await res.clone().text());
    const patient = /\/namespaces\/ts-patient-[^/]+\//.test(url.pathname);
    const slim = slimBody(parsed, patient);
    const chars = JSON.stringify(slim).length;
    if (chars <= MAX_RESPONSE_CHARS) return slim;
    return { omitted: `response over ${MAX_RESPONSE_CHARS} characters after trimming`, chars, ids: idsAndScores(parsed) };
  } catch {
    return undefined; // tracing must never break the request
  }
}

/** Cut long strings and, for a patient's notes, drop the note text. Keys and structure stay as turbopuffer sent them. */
function slimBody(v: unknown, patient: boolean, key?: string): unknown {
  if (typeof v === "string") {
    if (patient && key && NOTE_TEXT.has(key)) return "[note text not recorded]";
    return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… (${v.length.toLocaleString()} characters)` : v;
  }
  if (Array.isArray(v)) return v.map((x) => slimBody(x, patient, key));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "vector" ? "[vector not recorded]" : slimBody(x, patient, k)]));
  }
  return v;
}

/** Just the ids and scores, for a response too big to record whole. */
function idsAndScores(v: unknown): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (r: any) => (Array.isArray(r) ? r.map((x) => [x?.id, x?.$dist]) : undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = v as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return o?.results ? o.results.map((r: any) => rows(r?.rows)) : rows(o?.rows);
}

function safe(f: () => unknown) {
  try {
    f();
  } catch {
    // ignore tracing errors
  }
}
