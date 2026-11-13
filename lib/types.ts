// Types shared by the server routes and the browser.

export type Kind = "notes" | "pubmed" | "trials";
export type Mode = "hybrid" | "vector" | "bm25";
/** A searchable source. Only the shared corpora (pubmed, trials) are searched in this app; "notes" stays for the Hit shape the copilot uses. */
export type Source = "notes" | "pubmed" | "trials";

/**
 * One patient as the list, header, filters and prompts use it. Built in SQL from the patient row, their active primary
 * condition and their latest biomarker results (see lib/patients.ts), so the shape matches the original app's.
 */
export interface Patient {
  id: string;
  name: string;
  age: number;
  date_of_birth: string; // YYYY-MM-DD
  sex: string;
  city: string;
  state: string;
  specialty: "Oncology" | "Cardiology";
  ecog: number | null;
  primary_dx: string;
  stage: string;
  biomarkers: string;
  note_count: number;
}

export interface Condition {
  id: number;
  description: string;
  icd10_code: string | null;
  stage: string;
  is_primary: boolean;
  status: "active" | "resolved";
  diagnosed_on: string | null;
}

export interface Medication {
  id: number;
  name: string;
  drug_class: string;
  dose: string;
  started_on: string | null;
  stopped_on: string | null;
}

export interface Observation {
  id: number;
  kind: "lab" | "biomarker";
  name: string;
  value: number | null;
  unit: string;
  result: string;
  observed_on: string;
}

/** The structured record: conditions, current and past medications, and the latest result of each lab and biomarker. */
export interface PatientRecord {
  patient: Patient;
  conditions: Condition[];
  medications: Medication[];
  latest: Observation[];
  /** Every SQL statement that built this record, for the "From Supabase" line and the copilot step. */
  queries: { label: string; ms: number; rows: number }[];
}

export interface Note {
  id: string;
  title: string;
  body: string;
  note_type: string;
  visit_date: string;
  author: string;
}

export interface Signal {
  rank: number;
  score: number;
  of: number;
}

export interface Hit {
  key: string; // namespace:id, unique across sources
  id: string;
  kind: Kind;
  namespace: string;
  title: string;
  url: string | null;
  meta: string[];
  code: string | null;
  snippet: string;
  nsRank: number;
  overall: number;
  fused: number;
  rrf: number;
  vector: Signal | null;
  bm25: Signal | null;
  terms: string[];
  raw: Record<string, unknown>;
}

export interface NamespaceRun {
  namespace: string;
  short: string;
  kind: Kind;
  hits: number;
  roundMs: number;
  serverMs: number | null;
  embeddingMs: number | null;
  cache: string | null;
  docs: number | null;
  filters: string[];
  request: unknown;
}

export interface SearchFilters {
  status?: string[];
  phases?: string[];
  country?: string;
  matchPatient?: boolean;
  yearFrom?: number;
  topic?: "oncology" | "cardiology" | "";
  noteTypes?: string[];
  visitFrom?: string; // YYYY-MM-DD
  visitTo?: string;
}

/** One corpus: exact rows from an aggregate Count query, stored size from namespace metadata. */
export interface CorpusStat {
  namespace: string;
  rows: number;
  bytes: number | null;
  countMs: number;
  metadataMs: number;
}

/** Counts grouped by one field, from one aggregate query with group_by. */
export interface Facet {
  source: Source;
  namespace: string;
  field: "status" | "topic" | "note_type";
  groups: { value: string; count: number }[];
  ms: number;
}

export interface SearchResponse {
  query: string;
  mode: Mode;
  topK: number;
  rrfK: number;
  wallMs: number;
  embedModel: string;
  runs: NamespaceRun[];
  hits: Hit[];
}

export const KIND_LABEL: Record<Kind, string> = {
  notes: "Patient note",
  pubmed: "PubMed",
  trials: "Clinical trial",
};

// ---------------------------------------------------------------- copilot explainability

/** What one note save did in Postgres, for the "What the save did" panel. */
export interface WriteReport {
  table: "notes";
  kind: "insert" | "update";
  previous: Note | null; // the stored version before this save, for the diff
  sql: string; // the statement, with parameters shown as $1, $2…
  readMs: number; // looking up the previous version
  writeMs: number; // the insert or update, measured from the app server (network included)
  rowsAffected: number;
  updatedAt: string; // the row's updated_at after the save
}

/** Tokens and approximate cost for one copilot answer. */
export interface Usage {
  calls: number;
  /** All input tokens, cached or not. */
  inTokens: number;
  outTokens: number;
  /** Input tokens read from the prompt cache, and written to it (included in inTokens). */
  cacheRead?: number;
  cacheWrite?: number;
  /** US dollars at AI Gateway list prices; null when the price isn't known (e.g. calling Anthropic directly). */
  cost: number | null;
}
