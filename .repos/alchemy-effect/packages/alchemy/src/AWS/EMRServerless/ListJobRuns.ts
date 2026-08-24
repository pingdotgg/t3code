import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link ListJobRuns} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type ListJobRunsInput = Omit<emr.ListJobRunsRequest, "applicationId">;

/**
 * Runtime binding for `emr-serverless:ListJobRuns`.
 *
 * Enumerates job runs on the bound {@link Application}, optionally filtered
 * by state, creation window, or mode — so a function can report on running
 * or recently failed jobs. Provide the implementation with
 * `Effect.provide(AWS.EMRServerless.ListJobRunsHttp)`.
 * @binding
 * @section Running Jobs
 * @example List Running Jobs
 * ```typescript
 * // init
 * const listJobRuns = yield* AWS.EMRServerless.ListJobRuns(app);
 *
 * // runtime
 * const { jobRuns } = yield* listJobRuns({ states: ["RUNNING"] });
 * ```
 */
export interface ListJobRuns extends Binding.Service<
  ListJobRuns,
  "AWS.EMRServerless.ListJobRuns",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListJobRunsInput,
    ) => Effect.Effect<emr.ListJobRunsResponse, emr.ListJobRunsError>
  >
> {}
export const ListJobRuns = Binding.Service<ListJobRuns>(
  "AWS.EMRServerless.ListJobRuns",
);
