import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MultiRegionAccessPoint } from "./MultiRegionAccessPoint.ts";

/**
 * Runtime binding for `s3:GetMultiRegionAccessPointRoutes`.
 *
 * Reads the bound {@link MultiRegionAccessPoint}'s per-region routing
 * configuration (each region's `TrafficDialPercentage`) — the observe half
 * of an active/passive failover controller. Requests are routed to the
 * `us-west-2` MRAP control plane. Provide the implementation with
 * `Effect.provide(AWS.S3Control.GetMultiRegionAccessPointRoutesHttp)`.
 * @binding
 * @section Controlling Multi-Region Failover
 * @example Read the Current Routes
 * ```typescript
 * // init — bind the operation to the Multi-Region Access Point
 * const getRoutes =
 *   yield* AWS.S3Control.GetMultiRegionAccessPointRoutes(mrap);
 *
 * // runtime
 * const { Routes } = yield* getRoutes();
 * // Routes?.map((r) => `${r.Region}: ${r.TrafficDialPercentage}%`)
 * ```
 */
export interface GetMultiRegionAccessPointRoutes extends Binding.Service<
  GetMultiRegionAccessPointRoutes,
  "AWS.S3Control.GetMultiRegionAccessPointRoutes",
  (
    mrap: MultiRegionAccessPoint,
  ) => Effect.Effect<
    () => Effect.Effect<
      s3control.GetMultiRegionAccessPointRoutesResult,
      s3control.GetMultiRegionAccessPointRoutesError
    >
  >
> {}
export const GetMultiRegionAccessPointRoutes =
  Binding.Service<GetMultiRegionAccessPointRoutes>(
    "AWS.S3Control.GetMultiRegionAccessPointRoutes",
  );
