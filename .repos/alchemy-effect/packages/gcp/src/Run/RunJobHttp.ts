import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Job } from "./Job.ts";
import { RunJob, type RunJobRequest } from "./RunJob.ts";

/**
 * HTTP implementation of {@link RunJob}.
 *
 * @layer
 * @provides GCP.Run.RunJob
 */
export const RunJobHttp = Layer.effect(
  RunJob,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(cloudrun.runProjectsLocationsJobs);
    return Effect.fn(function* <T extends Job>(job: T) {
      const name = yield* job.name;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Run.RunJob(${job})`({
          iam: [
            // runWithOverrides: RunJobRequest accepts `body.overrides`.
            grantFor({ role: "roles/run.jobsExecutorWithOverrides", on: "run.job" }, job.name),
          ],
        });
      }
      return Effect.fn(`GCP.Run.RunJob(${job.LogicalId})`)(function* (request?: RunJobRequest) {
        return yield* run({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
