-- Keeps the Kobo function warm: one call a minute (docs/kobo.md, "Speed"). Idempotent.
-- The path carries no device token and does nothing but one small read.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'atril-kobo-warm';
select cron.schedule('atril-kobo-warm', '* * * * *', $$
  select net.http_get(url := 'https://uxavtsscsgtcjxfmfwrp.supabase.co/functions/v1/kobo/ping')
$$);
