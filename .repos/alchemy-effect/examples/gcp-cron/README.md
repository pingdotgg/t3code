# Scheduled work on Cloud Run

A Cloud Run service with two Cloud Scheduler cron handlers that write into BigQuery, and one public route that reads the rows back.

- [`Monitor`](./src/Monitor.ts): a `GCP.Function` (Cloud Run service).
  - Runs every minute. Records a heartbeat row whose `value` is the delivery lag in milliseconds.
  - Runs daily at 00:00 UTC. Counts the last day's heartbeats and records the count.
  - Serves `GET /heartbeats?kind=heartbeat|daily&limit=N`, which returns the newest rows first.
- [`Heartbeats`](./src/resources.ts): the BigQuery table, in the `Monitoring` dataset.

## Bindings and event sources

| Binding | Grants the service's runtime account |
| --- | --- |
| `GCP.CloudScheduler.consumeSchedule` + `GCP.Run.ScheduleEventSource` (×2) | `roles/run.invoker` on the service. Each schedule gets one Cloud Scheduler job that `POST`s to `/__alchemy/scheduler/<id>` with an OIDC token for that account. |
| `GCP.BigQuery.WriteTable` + `WriteTableHttp` | `roles/bigquery.dataEditor` on the table |
| `GCP.BigQuery.ReadTable` + `ReadTableHttp` | `roles/bigquery.dataViewer` on the table and `roles/bigquery.jobUser` on the project, because query jobs can only be granted at project level |

The service sets `invokerIamDisabled: true`, so `GET /heartbeats` is public. The schedule routes stay closed. The runtime verifies each delivery's OIDC token, checking both the audience and the service's own account, and answers `401` to anything else.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/gcp-cron
pnpm deploy --profile <name>
```

This needs a local Docker daemon to build the image. Then:

```sh
curl "$URL/heartbeats?kind=heartbeat&limit=5"
```

Use the printed `url`. A heartbeat row appears within a minute. To run a schedule immediately, use `gcloud scheduler jobs run <job> --location <region>`.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test
```

The test deploys the stack and forces one run of each job with `cloudscheduler.runProjectsLocationsJobs`. It polls `GET /heartbeats` until both rows appear and checks them with a direct BigQuery query. Then it destroys the stack and verifies the scheduler jobs and table are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
