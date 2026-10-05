import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";
import { RunJob, type RunJobRequest } from "./RunJob.ts";
import type { Job } from "./Job.ts";

/**
 * HTTP implementation of {@link RunJob}.
 *
 * @layer
 * @provides GCP.Run.RunJob
 */
export const RunJobHttp = Layer.effect(
  RunJob,
  Effect.gen(function* () {
    const run = yield* cloudrun.runProjectsLocationsJobs;
    return Effect.fn(function* <T extends Job>(job: T) {
      const name = yield* job.name;
      yield* bindGcpHost({
        tag: "GCP.Run.RunJob",
        resource: job,
        iam: [
          // runWithOverrides: RunJobRequest accepts `body.overrides`.
          grantFor(
            { role: "roles/run.jobsExecutorWithOverrides", on: "run.job" },
            job.name,
          ),
        ],
      });
      return Effect.fn(`GCP.Run.RunJob(${job.LogicalId})`)(function* (
        request?: RunJobRequest,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
