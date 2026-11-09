# Sessions to Bitácora

Bitácora is the user's time tracker (repo `time-tracker`, its own Supabase). Since
2026-11-09 Atril's reading and listening sessions reach it on their own (phase 7 of the
ecosystem plan; the user chose "a book adds to its subject": the time of a resumidor book
counts as time of that subject's activity).

## Contract

Atril writes one row of Bitácora's `buckets` table, `<BITACORA_BUCKET>::atril`, and is its
only writer. Bitácora (app and web) only reads it and merges it with its own tested logic
(`AtrilImport` there, `docs/atril.md` in that repo). The two databases stay separate.

```json
{ "v": 1, "profile": "default",
  "books": [{ "id", "title", "author", "subject" }],
  "sessions": [{ "id", "bookId", "kind", "start" (ms), "seconds", "updatedAt" (ms) }] }
```

Sessions of the last 60 days with a book and some time; only the books they use; stable
order, so the same data gives the same JSON. Built by `supabase/functions/bitacora/logic.ts`
(tested in `logic_test.ts`, run by CI with Deno).

`books.subject` (schema.sql) is the subject a book belongs to, set by
`tts-worker/publish_book.py --subject`, which `resumidor/audiolibro/tools/a_atril.py` passes.

## Running

- Edge Function `bitacora`, deployed with `--no-verify-jwt`; it answers only a request
  carrying `x-cron-secret`. It reads with the service role, compares with the row already
  in Bitácora and writes only when something changed.
- pg_cron calls it every 15 minutes (`supabase/bitacora.sql`, job `atril-bitacora`); the
  secret it sends is in Vault (`bitacora_cron_secret`), never in the repo.
- Secrets (`supabase secrets set`): `BITACORA_URL`, `BITACORA_KEY` (its anon key),
  `BITACORA_BUCKET` (its USER_KEY), `BITACORA_PROFILE` (`default`), `ATRIL_USER` (the
  user's auth id), `BITACORA_CRON_SECRET`.
- Deploy: `SUPABASE_ACCESS_TOKEN=<short-lived PAT> npx supabase functions deploy bitacora
  --project-ref uxavtsscsgtcjxfmfwrp --use-api --no-verify-jwt`; the user revokes the
  token afterwards.
- Check: `select * from cron.job_run_details order by start_time desc limit 5;` and the
  function's logs; in Bitácora, the row `<USER_KEY>::atril`.
