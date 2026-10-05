import type * as cloudrun from "@distilled.cloud/gcp/run_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Job } from "./Job.ts";

export interface RunJobRequest extends Omit<
  cloudrun.RunProjectsLocationsJobsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Run `jobs.run`.
 *
 * Triggers a new execution of the bound {@link Job}. Provide
 * {@link RunJobHttp}.
 *
 * ### Running Jobs
 * **Example:** Trigger an execution
 * ```typescript
 * const runJob = yield* GCP.Run.RunJob(job);
 * yield* runJob();
 * ```
 *
 * **Example:** Override task count
 * ```typescript
 * const runJob = yield* GCP.Run.RunJob(job);
 * yield* runJob({
 *   body: { overrides: { taskCount: 1 } },
 * });
 * ```
 *
 * @binding
 * @category Run
 */
export interface RunJob extends Binding.Service<
  RunJob,
  "GCP.Run.RunJob",
  (
    job: Job,
  ) => Effect.Effect<
    (
      request?: RunJobRequest,
    ) => Effect.Effect<
      cloudrun.GoogleLongrunningOperation,
      cloudrun.RunProjectsLocationsJobsError,
      RuntimeContext
    >
  >
> {}

export const RunJob = Binding.Service<RunJob>("GCP.Run.RunJob");
