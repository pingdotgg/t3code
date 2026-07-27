import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MultiRegionAccessPoint } from "./MultiRegionAccessPoint.ts";

/**
 * Runtime binding for `s3:SubmitMultiRegionAccessPointRoutes`.
 *
 * Shifts traffic between the bound {@link MultiRegionAccessPoint}'s regions
 * by dialing each region's `TrafficDialPercentage` (0 = passive, 100 =
 * active) — the act half of an automated failover controller, e.g. a
 * health-check Lambda that dials a degraded region to 0. Requests are
 * routed to the `us-west-2` MRAP control plane. Provide the implementation
 * with `Effect.provide(AWS.S3Control.SubmitMultiRegionAccessPointRoutesHttp)`.
 * @binding
 * @section Controlling Multi-Region Failover
 * @example Fail Traffic Away from a Region
 * ```typescript
 * // init — bind the operation to the Multi-Region Access Point
 * const submitRoutes =
 *   yield* AWS.S3Control.SubmitMultiRegionAccessPointRoutes(mrap);
 *
 * // runtime
 * yield* submitRoutes({
 *   RouteUpdates: [
 *     { Region: "us-west-2", TrafficDialPercentage: 0 },
 *     { Region: "eu-west-1", TrafficDialPercentage: 100 },
 *   ],
 * });
 * ```
 */
export interface SubmitMultiRegionAccessPointRoutes extends Binding.Service<
  SubmitMultiRegionAccessPointRoutes,
  "AWS.S3Control.SubmitMultiRegionAccessPointRoutes",
  (
    mrap: MultiRegionAccessPoint,
  ) => Effect.Effect<
    (
      request: Omit<
        s3control.SubmitMultiRegionAccessPointRoutesRequest,
        "AccountId" | "Mrap"
      >,
    ) => Effect.Effect<
      s3control.SubmitMultiRegionAccessPointRoutesResult,
      s3control.SubmitMultiRegionAccessPointRoutesError
    >
  >
> {}
export const SubmitMultiRegionAccessPointRoutes =
  Binding.Service<SubmitMultiRegionAccessPointRoutes>(
    "AWS.S3Control.SubmitMultiRegionAccessPointRoutes",
  );
