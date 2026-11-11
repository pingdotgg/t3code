# Event pipeline: Pub/Sub to BigQuery

An analytics pipeline. A public Cloud Run service accepts events and publishes them to Pub/Sub. A Cloud Run Job drains the backlog into BigQuery in batches. Nothing touches BigQuery on the request path, so a slow warehouse cannot take ingestion down.

```sh
curl -X POST "$URL/events" -H 'content-type: application/json' -d '{"type":"signup","payload":{"plan":"pro"}}'
# 202 {"id":"5f0c…"}
curl -X POST "$URL/drain"
# 202 {"execution":"projects/…/executions/…"}
curl "$URL/events/count?type=signup"
# 200 {"count":1}
```

## Architecture

- [`Events`](./src/resources.ts) — Pub/Sub topic every event is published to.
- [`Inbox`](./src/resources.ts) — pull subscription on `Events`. It holds messages until they are acked, so the drain can run whenever a batch is due.
- [`Analytics`](./src/resources.ts) / [`EventsTable`](./src/resources.ts) — BigQuery dataset and `events` table (`id`, `type`, `occurredAt`, `payload` as JSON).
- [`Ingest`](./src/Ingest.ts) — public `GCP.Function` (a Cloud Run service):
  - `POST /events` — publish `{ type, payload }` to the topic.
  - `POST /drain` — start a `Drain` execution now.
  - `GET /events/count?type=` — count rows in BigQuery.
- [`Drain`](./src/Drain.ts) — `GCP.Run.Job`. It pulls batches of up to 100 messages, inserts them into the table, and acks them, until a pull comes back empty.

The drain inserts first and acks second. A crash between the two redelivers the batch; BigQuery `insertIds` collapse the duplicates inside its dedup window.

## Bindings and IAM

| Host   | Binding                                                          | IAM granted to the host's service account                                            |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Ingest | `GCP.PubSub.WriteTopic(Events)` + `WriteTopicHttp`               | `roles/pubsub.publisher` on the topic                                                |
| Ingest | `GCP.BigQuery.ReadTable(EventsTable)` + `ReadTableHttp`          | `roles/bigquery.dataViewer` on the table; `roles/bigquery.jobUser` on the project (query jobs can only be granted there) |
| Ingest | `GCP.Run.RunJob(Drain)` + `RunJobHttp`                           | `roles/run.jobsExecutorWithOverrides` on the `Drain` job                             |
| Drain  | `GCP.PubSub.ReadSubscription(Inbox)` + `ReadSubscriptionHttp`    | `roles/pubsub.subscriber` on the subscription                                        |
| Drain  | `GCP.BigQuery.WriteTable(EventsTable)` + `WriteTableHttp`        | `roles/bigquery.dataEditor` on the table                                             |

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

From the repository root:

```sh
pnpm install
cd examples/gcp-event-pipeline
pnpm deploy --profile <name>
```

Docker must be running, because both hosts are built locally from `main`. To drain on a schedule instead of on demand, point a Cloud Scheduler job at `Drain`.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test --timeout 1200000
```

[The test](./test/integ.test.ts) deploys the stack and publishes events, checking that nothing reaches BigQuery before a drain. It then starts `Drain` through `POST /drain` and polls `GET /events/count` until the rows land. At the end it destroys the stack.

A Cloud Run Job execution can take a couple of minutes to start.

## Destroy

```sh
pnpm destroy --profile <name>
```

This deletes the service, the job, their IAM grants, the subscription, the topic, and the dataset with its table.
