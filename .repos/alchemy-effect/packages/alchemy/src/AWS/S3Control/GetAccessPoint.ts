import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AccessPoint } from "./AccessPoint.ts";

/**
 * Runtime binding for `s3:GetAccessPoint`.
 *
 * Reads the bound {@link AccessPoint}'s live configuration — bucket,
 * network origin, public-access-block flags, alias and endpoints — e.g. an
 * operational dashboard or a controller that verifies the access point is
 * still wired to the expected bucket. The access point name and owning
 * account are injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.S3Control.GetAccessPointHttp)`.
 * @binding
 * @section Observing an Access Point
 * @example Read the Access Point's Configuration
 * ```typescript
 * // init — bind the operation to the access point
 * const getAccessPoint = yield* AWS.S3Control.GetAccessPoint(accessPoint);
 *
 * // runtime
 * const live = yield* getAccessPoint();
 * // live.Bucket, live.NetworkOrigin, live.Endpoints
 * ```
 */
export interface GetAccessPoint extends Binding.Service<
  GetAccessPoint,
  "AWS.S3Control.GetAccessPoint",
  (
    accessPoint: AccessPoint,
  ) => Effect.Effect<
    () => Effect.Effect<
      s3control.GetAccessPointResult,
      s3control.GetAccessPointError
    >
  >
> {}
export const GetAccessPoint = Binding.Service<GetAccessPoint>(
  "AWS.S3Control.GetAccessPoint",
);
