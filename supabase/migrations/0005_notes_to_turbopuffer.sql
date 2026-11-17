-- Notes move to turbopuffer. Each patient's notes now live only in their ts-patient-{id} namespace, which the app reads
-- and writes directly (lib/notes.ts), shared with the original TrialScope apps. The sync from this database to
-- turbopuffer (0002, the pg_cron job and /api/index-notes) is retired:
--
--   1. Unschedule the pg_cron job and delete its secret from Vault, if they exist.
--   2. Drop the sync columns and index from notes (0002).
--   3. Rename notes to notes_archive and take away the app's access. Nothing is deleted: drop the table yourself once
--      you're sure you don't need it (drop table notes_archive;).
--
-- Safe to run more than once (npm run migrate): every step checks first.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'index-notes'$q$;
  end if;
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    execute $q$delete from vault.secrets where name = 'index_notes_secret'$q$;
  end if;
end $$;

do $$
begin
  if to_regclass('public.notes') is not null and to_regclass('public.notes_archive') is null then
    drop index if exists notes_index_pending;
    alter table notes
      drop column if exists indexed_at,
      drop column if exists index_error,
      drop column if exists index_attempts;
    alter table notes rename to notes_archive;
    alter index if exists notes_patient rename to notes_archive_patient;
  end if;
  if to_regclass('public.notes_archive') is not null
     and exists (select 1 from pg_roles where rolname = 'trialscope_app') then
    revoke all on notes_archive from trialscope_app;
  end if;
end $$;
