import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link ListJobRunAttempts} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type ListJobRunAttemptsInput = Omit<
  emr.ListJobRunAttemptsRequest,
  "applicationId"
>;

/**
 * Runtime binding for `emr-serverless:ListJobRunAttempts`.
 *
 * Enumerates the attempts of a retried job run on the bound
 * {@link Application} — how many times the retry policy re-ran the job and
 * how each attempt ended. Provide the implementation with
 * `Effect.provide(AWS.EMRServerless.ListJobRunAttemptsHttp)`.
 * @binding
 * @section Running Jobs
 * @example Inspect A Job's Attempts
 * ```typescript
 * // init
 * const listJobRunAttempts = yield* AWS.EMRServerless.ListJobRunAttempts(app);
 *
 * // runtime
 * const { jobRunAttempts } = yield* listJobRunAttempts({ jobRunId });
 * ```
 */
export interface ListJobRunAttempts extends Binding.Service<
  ListJobRunAttempts,
  "AWS.EMRServerless.ListJobRunAttempts",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: ListJobRunAttemptsInput,
    ) => Effect.Effect<
      emr.ListJobRunAttemptsResponse,
      emr.ListJobRunAttemptsError
    >
  >
> {}
export const ListJobRunAttempts = Binding.Service<ListJobRunAttempts>(
  "AWS.EMRServerless.ListJobRunAttempts",
);
