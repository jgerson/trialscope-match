-- Candidate patients is gone from the app (its criteria-to-rules cache was trial_rules, from 0003 and 0004), so the
-- table goes too. This deletes the cached rules; nothing else uses them. Safe to run more than once.
drop table if exists trial_rules;
