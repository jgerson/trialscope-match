-- Notes sync: which version of each note is in the turbopuffer namespace match-notes.
--
-- A note is waiting to be indexed when indexed_at is null or older than updated_at. Every save already sets
-- updated_at = now(), so saving a note marks it in the same statement: there is no separate queue that a save could
-- forget to write, an edit made twice before indexing is indexed once, and nothing has to be deleted afterwards (the
-- app's role can't delete). The indexer sets indexed_at to the updated_at it indexed, only if the note hasn't changed
-- since, so an edit made mid-index stays waiting.
--
-- Safe to run more than once (npm run migrate). The existing grant on notes already covers the new columns.

alter table notes
  add column if not exists indexed_at     timestamptz,           -- the updated_at of the version in turbopuffer; null = never
  add column if not exists index_error    text,                  -- the last indexing failure, if any
  add column if not exists index_attempts int not null default 0;

-- Only the notes waiting to be indexed, so it stays tiny however many notes there are.
create index if not exists notes_index_pending on notes (updated_at)
  where indexed_at is null or indexed_at < updated_at;
