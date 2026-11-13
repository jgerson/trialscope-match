-- Row-level security on trial_rules, like every other table (0001). Supabase grants its public anon and authenticated
-- roles access to new tables in the public schema, so without RLS anyone with the project URL and anon key could read,
-- change or delete cached rules through the REST API. With RLS on and policies only for trialscope_app, those roles
-- see nothing.
--
-- Safe to run more than once (npm run migrate).

alter table trial_rules enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'trial_rules' and policyname = 'app_read') then
    create policy app_read on trial_rules for select to trialscope_app using (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trial_rules' and policyname = 'app_insert') then
    create policy app_insert on trial_rules for insert to trialscope_app with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trial_rules' and policyname = 'app_update') then
    create policy app_update on trial_rules for update to trialscope_app using (true) with check (true);
  end if;
end $$;

-- The anon and authenticated roles never need this table.
revoke all on trial_rules from anon, authenticated;
