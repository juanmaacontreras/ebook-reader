-- Sends the reading sessions to Bitácora every 15 minutes (docs/bitacora.md).
-- Idempotent: run it again after changing the schedule.
-- Once, by hand, before this file (the secret never goes in the repo; the same value is the
-- function's BITACORA_CRON_SECRET):
--   select vault.create_secret('<random secret>', 'bitacora_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'atril-bitacora';
select cron.schedule('atril-bitacora', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://uxavtsscsgtcjxfmfwrp.supabase.co/functions/v1/bitacora',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bitacora_cron_secret')),
    body := '{}'::jsonb)
$$);
