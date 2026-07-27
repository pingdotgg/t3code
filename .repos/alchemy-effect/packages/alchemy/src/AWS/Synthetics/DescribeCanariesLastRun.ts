import type * as synthetics from "@distilled.cloud/aws/synthetics";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `synthetics:DescribeCanariesLastRun` — read the most
 * recent run of every canary in the account (optionally filtered by
 * `Names`), e.g. to render a fleet-wide status page.
 *
 * Provide `Synthetics.DescribeCanariesLastRunHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Canary Status
 * @example Fleet-Wide Last-Run Summary
 * ```typescript
 * // init — grants synthetics:DescribeCanariesLastRun
 * const describeCanariesLastRun =
 *   yield* AWS.Synthetics.DescribeCanariesLastRun();
 *
 * // runtime
 * const { CanariesLastRun } = yield* describeCanariesLastRun();
 * const failing = CanariesLastRun?.filter(
 *   (c) => c.LastRun?.Status?.State === "FAILED",
 * );
 * ```
 */
export interface DescribeCanariesLastRun extends Binding.Service<
  DescribeCanariesLastRun,
  "AWS.Synthetics.DescribeCanariesLastRun",
  () => Effect.Effect<
    (
      request?: synthetics.DescribeCanariesLastRunRequest,
    ) => Effect.Effect<
      synthetics.DescribeCanariesLastRunResponse,
      synthetics.DescribeCanariesLastRunError
    >
  >
> {}

export const DescribeCanariesLastRun = Binding.Service<DescribeCanariesLastRun>(
  "AWS.Synthetics.DescribeCanariesLastRun",
);
