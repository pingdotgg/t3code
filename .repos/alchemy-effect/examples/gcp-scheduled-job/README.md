# Nightly batch on a Cloud Run Job

A Cloud Run Job that rolls the last 24 hours of orders in BigQuery up into a JSON summary in Cloud Storage. Cloud Scheduler runs it every night, and a public admin route runs it on demand.

- [`Summarize`](./src/Summarize.ts): a `GCP.Run.Job` with an Effect-native `run` entry. It queries the `orders` table grouped by region and writes `daily/<YYYY-MM-DD>.json` with per-region and overall order counts and revenue. Re-running on the same day overwrites that day's object.
- [`Nightly`](./src/Nightly.ts): a `GCP.CloudScheduler.Job` that `POST`s to the Cloud Run Admin API's `jobs:run` endpoint for `Summarize` at 02:00 UTC. It authenticates with an OAuth token for the job's own runtime service account, which a `GCP.IAM.Member` grants `roles/run.invoker` on the job.
- [`Admin`](./src/Admin.ts): a public `GCP.Function` (Cloud Run service). `POST /run` starts an execution and returns its operation name.
- [`Orders`, `Reports`](./src/resources.ts): the BigQuery table (in the `Warehouse` dataset) and the bucket the summaries land in.

A summary looks like this:

```json
{
  "from": "2026-09-26T02:00:04.120Z",
  "to": "2026-09-27T02:00:04.120Z",
  "execution": "summarize-abcde",
  "orders": 5,
  "revenueCents": 5999,
  "regions": [
    { "region": "east", "orders": 3, "revenueCents": 3999 },
    { "region": "west", "orders": 2, "revenueCents": 2000 }
  ]
}
```

## Bindings and IAM

| Binding / resource | Grants |
| --- | --- |
| `GCP.BigQuery.ReadTable` + `ReadTableHttp` (on `Summarize`) | the job's runtime account `roles/bigquery.dataViewer` on the table and `roles/bigquery.jobUser` on the project, because query jobs can only be granted at project level |
| `GCP.Storage.WriteBucket` + `WriteBucketHttp` (on `Summarize`) | the job's runtime account `roles/storage.objectUser` on the bucket |
| `GCP.Run.RunJob` + `RunJobHttp` (on `Admin`) | the service's runtime account `roles/run.jobsExecutorWithOverrides` on the job |
| `GCP.IAM.Member("NightlyRunner")` | the job's runtime account `roles/run.invoker` on the job, which includes `run.jobs.run`. Cloud Scheduler mints the OAuth token for that account. |

Cloud Scheduler uses an OAuth token, not OIDC, because the target is a `*.googleapis.com` API rather than a Cloud Run URL. `Admin` sets `invokerIamDisabled: true` so the example can be driven with `curl`; in production, drop it and call `/run` with an identity token.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/gcp-scheduled-job
pnpm deploy --profile <name>
```

This needs a local Docker daemon to build the images. Then start a run with the printed `url`:

```sh
curl -X POST "$URL/run"
```

A Cloud Run Job execution can take a couple of minutes to start. To run the schedule itself, use `gcloud scheduler jobs run <schedulerJobName> --location <region>`.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test
```

The test deploys the stack and seeds five orders with BigQuery `insertAll`. It calls `POST /run`, polls the bucket until a summary with the seeded regions appears, and checks the counts and totals. It then forces the Cloud Scheduler job with `cloudscheduler.runProjectsLocationsJobs` and waits for a new execution of the job. Finally it destroys the stack and verifies the job, the scheduler job, and the bucket are gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
