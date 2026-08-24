import type * as SVC from "@distilled.cloud/aws/databrew";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

/**
 * Runtime binding for `databrew:StartJobRun` — lets a workload kick off a
 * run of a DataBrew job (a `PROFILE` analysis or a `RECIPE` transformation).
 *
 * The response carries the `RunId`, which can be observed with the
 * {@link DescribeJobRun} binding and cancelled with {@link StopJobRun}.
 * @binding
 * @section Starting Job Runs
 * @example Start a Job Run
 * ```typescript
 * const startJobRun = yield* AWS.DataBrew.StartJobRun(job);
 *
 * const { RunId } = yield* startJobRun();
 * ```
 */
export interface StartJobRun extends Binding.Service<
  StartJobRun,
  "AWS.DataBrew.StartJobRun",
  <J extends Job>(
    job: J,
  ) => Effect.Effect<
    () => Effect.Effect<SVC.StartJobRunResponse, SVC.StartJobRunError>
  >
> {}
export const StartJobRun = Binding.Service<StartJobRun>(
  "AWS.DataBrew.StartJobRun",
);
