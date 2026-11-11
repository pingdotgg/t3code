# Pub/Sub job queue on Cloud Run

A background job queue. A public Cloud Run API enqueues jobs on a Pub/Sub topic; a Cloud Run worker pool pulls them, "processes" each payload (SHA-256, word and character counts), and writes the result to Firestore, where the API serves it.

```sh
curl -X POST "$URL/jobs" -d '{"payload":"hello world"}'
# 202 {"id":"5f0c…","status":"pending"}
curl "$URL/jobs/5f0c…"
# 200 {"id":"5f0c…","status":"done","sha256":"b94d…","words":2,"chars":11,…}
```

## Architecture

- [`Jobs`](./src/resources.ts) — Pub/Sub topic, the queue.
- [`Results`](./src/resources.ts) — named Firestore Native database; one document per job at `jobs/{id}`.
- [`Api`](./src/Api.ts) — `GCP.Function` (a Cloud Run service) with a public URL. `POST /jobs` publishes, `GET /jobs/:id` reads the result (`202 pending` until it exists).
- [`Worker`](./src/Worker.ts) — `GCP.Run.WorkerPool` with one instance. No inbound URL; it pulls from the topic in a background loop.

## Bindings and event sources

| Host   | Binding / event source                                            | IAM granted to the host's service account                                                                  |
| ------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Api    | `GCP.PubSub.WriteTopic(Jobs)` + `WriteTopicHttp`                  | `roles/pubsub.publisher` on the topic                                                                      |
| Api    | `GCP.Firestore.ReadDatabase(Results)` + `ReadDatabaseHttp`        | `roles/datastore.viewer` on the project, conditioned to the `Results` database                             |
| Worker | `GCP.PubSub.consumeTopicMessages(Jobs)` + `GCP.Run.TopicPullEventSource` | creates a pull subscription on the topic; `roles/pubsub.subscriber` on that subscription (pull + ack) |
| Worker | `GCP.Firestore.WriteDatabase(Results)` + `WriteDatabaseHttp`      | `roles/datastore.user` on the project, conditioned to the `Results` database                               |

Firestore databases have no resource-level IAM policy, so the Firestore grants are project-level with an IAM Condition on the database name. They can take a few minutes to propagate after the first deploy.

## Delivery semantics

Pub/Sub is at-least-once. The pull loop acks a batch only after the handler succeeds; a failed handler (or a crashed instance) leaves it unacked, and Pub/Sub redelivers it after the 60-second ack deadline. Redelivery is safe here because the worker writes each result with `set`, so a repeated job overwrites its document with the same values. Messages that can never parse are logged and acked instead of redelivered forever.

This example has no dead-letter topic: a job that keeps failing is retried until the subscription's message retention (7 days) expires. For production, add a dead-letter policy and an alert on it.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

From the repository root:

```sh
pnpm install
cd examples/gcp-pubsub-worker
pnpm deploy --profile <name>
```

Deploying builds both container images locally, so Docker must be running.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, submits several jobs, polls `GET /jobs/:id` until every job is done, checks each result against the Firestore document out of band, then destroys the stack and checks the topic, subscription, worker pool, and database are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
