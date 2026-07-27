import type * as synthetics from "@distilled.cloud/aws/synthetics";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Canary } from "./Canary.ts";

export interface GetCanaryRunsRequest extends Omit<
  synthetics.GetCanaryRunsRequest,
  "Name"
> {}

/**
 * Runtime binding for `synthetics:GetCanaryRuns` — list the run results
 * (status, timeline, artifact location) of the bound {@link Canary}; the
 * canary name is injected automatically.
 *
 * Provide `Synthetics.GetCanaryRunsHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Canary Runs
 * @example List Recent Runs
 * ```typescript
 * // init — grants synthetics:GetCanaryRuns on the canary
 * const getCanaryRuns = yield* AWS.Synthetics.GetCanaryRuns(canary);
 *
 * // runtime
 * const { CanaryRuns } = yield* getCanaryRuns({ MaxResults: 10 });
 * const failed = CanaryRuns?.filter((run) => run.Status?.State === "FAILED");
 * ```
 */
export interface GetCanaryRuns extends Binding.Service<
  GetCanaryRuns,
  "AWS.Synthetics.GetCanaryRuns",
  (
    canary: Canary,
  ) => Effect.Effect<
    (
      request?: GetCanaryRunsRequest,
    ) => Effect.Effect<
      synthetics.GetCanaryRunsResponse,
      synthetics.GetCanaryRunsError
    >
  >
> {}

export const GetCanaryRuns = Binding.Service<GetCanaryRuns>(
  "AWS.Synthetics.GetCanaryRuns",
);
