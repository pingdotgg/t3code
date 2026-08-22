# github pr event feed

this package runs the hosted github webhook and replayable server-sent event feed used by pr babysitters.

it is a standalone cloudflare worker with one durable object per repository. the durable object orders deliveries, retains the latest 512 normalized events, deduplicates the latest 10,000 delivery ids, remembers recent sha-to-pr associations, replays from `last-event-id`, and fans new events out to at most 64 connected sse subscribers.

## commands

```sh
vp run --filter t3code-github-events typecheck
vp test run infra/github-events/src/*.test.ts
vp run --filter t3code-github-events dev --stage dev_$USER
vp run --filter t3code-github-events deploy --stage prod
```

copy `.env.example` to `.env` for local development. deployment requires cloudflare credentials plus the two application secrets.

see `docs/operations/github-pr-event-feed.md` for webhook setup, subscription examples, and the event schema.
