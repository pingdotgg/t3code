# Product analytics

The server owns analytics delivery, opt-out, and identity for every connected client. Clients never
load the PostHog browser SDK, PostHog person profiles stay disabled, and visiting hosted web without
an authenticated connection does not count as product use.

## Identity

- **`distinct_id` is the install id.** Both are the hash of a random id persisted in the state
  directory. Events carry it under both names because older builds derived `distinct_id` from the
  Codex or Claude sign-in files, so the ingest side counts installs by `installId`.
- **Identity never comes from a provider.** Do not read a provider's sign-in files or derive an id
  or owner from a user's OpenAI, Claude, or other provider account, even hashed: users did not sign
  in to those to be identified by T3 Code.
- **Resolve owners at query time.** `install.owner_observed` links installs to owners (Connect
  account, client device). Two Connect accounts are never merged as one person.
- **Hash everywhere with [one helper](../../packages/shared/src/telemetryId.ts).** Clients and
  servers hash with the same SHA-256 helper so IDs correlate; the server accepts only hashes from
  clients.

## Attribution boundaries

- Client dimensions (`surface`, etc.) belong to the event's WebSocket connection, never a
  server-global "current client". Keep client and server dimensions separate, and leave missing
  client metadata unknown rather than backfilling from server properties.
- Active-use reports count `client.turn.requested` (deduplicated by command ID), not connections
  (T3 Connect sessions renew hourly).

## Collection boundary and delivery

- Payloads stay strictly to product metadata, closed contract enums, and normalized measurements:
  never attach prompts, file paths, credentials, raw provider payloads, device names, conversation
  IDs, or user-named provider instance IDs. Model IDs are reported as the provider used them,
  including custom models; known aliases and routed IDs map to one catalog slug, and a model
  that is a file path reports only its file name.
- The sole exception is opt-in `agent.feedback`, which
  [`FeedbackService`](../../apps/server/src/feedback/FeedbackService.ts) scrubs of paths, private
  values, and secret-shaped strings, and only attaches bounded conversation traces when the user
  explicitly previews and sends them.
- Delivery ([`AnalyticsService.ts`](../../apps/server/src/telemetry/AnalyticsService.ts)) attaches a
  UUID per event, backs off on failure, and drops batches after bounded retries so a stuck batch
  cannot loop forever.
- Dev-runner servers and CI smoke tests disable telemetry (and relay tracing) by default so they do
  not inflate install counts; set `T3CODE_TELEMETRY_ENABLED=true` to test locally.
