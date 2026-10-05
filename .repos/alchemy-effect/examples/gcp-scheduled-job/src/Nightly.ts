import * as GCP from "alchemy/GCP";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Summarize from "./Summarize.ts";

/**
 * Runs {@link Summarize} every night at 02:00 UTC.
 *
 * Cloud Scheduler calls the Cloud Run Admin API's `jobs:run` endpoint
 * directly, so no service sits between the schedule and the job. It
 * authenticates with an OAuth token (not OIDC — the target is a
 * `*.googleapis.com` API, not a Cloud Run URL) minted for the job's own
 * runtime service account, which is granted `roles/run.invoker` on this
 * one job — that role carries `run.jobs.run`.
 */
export const Nightly = Effect.gen(function* () {
  const job = yield* Summarize;

  const runner = yield* GCP.IAM.Member("NightlyRunner", {
    kind: "run.job",
    name: job.name,
    role: "roles/run.invoker",
    member: Output.interpolate`serviceAccount:${job.serviceAccount}`,
  });

  return yield* GCP.CloudScheduler.Job("Nightly", {
    schedule: "0 2 * * *",
    timeZone: "Etc/UTC",
    description: "nightly order summary",
    // A fresh grant can take a minute to propagate; a 403 on the first
    // attempt is retried instead of skipping the night.
    retryConfig: {
      retryCount: 3,
      minBackoffDuration: "30s",
      maxBackoffDuration: "300s",
    },
    httpTarget: {
      uri: Output.interpolate`https://run.googleapis.com/v2/${job.name}:run`,
      httpMethod: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      oauthToken: {
        // Reading the grant's member orders the scheduler after the grant.
        serviceAccountEmail: Output.map(runner.member, (member) =>
          member.replace(/^serviceAccount:/, ""),
        ),
        scope: "https://www.googleapis.com/auth/cloud-platform",
      },
    },
  });
});
