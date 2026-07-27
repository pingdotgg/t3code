import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AccessPoint } from "./AccessPoint.ts";

/**
 * Runtime binding for `s3:GetAccessPointPolicyStatus`.
 *
 * Indicates whether the bound {@link AccessPoint}'s policy currently allows
 * public access — e.g. a compliance auditor Lambda that alerts on publicly
 * exposed access points. An access point without a policy fails with the
 * typed `NoSuchAccessPointPolicy` tag. Provide the implementation with
 * `Effect.provide(AWS.S3Control.GetAccessPointPolicyStatusHttp)`.
 * @binding
 * @section Observing an Access Point
 * @example Check Whether the Access Point Is Public
 * ```typescript
 * // init — bind the operation to the access point
 * const getPolicyStatus =
 *   yield* AWS.S3Control.GetAccessPointPolicyStatus(accessPoint);
 *
 * // runtime
 * const status = yield* getPolicyStatus();
 * // status.PolicyStatus?.IsPublic === false
 * ```
 */
export interface GetAccessPointPolicyStatus extends Binding.Service<
  GetAccessPointPolicyStatus,
  "AWS.S3Control.GetAccessPointPolicyStatus",
  (
    accessPoint: AccessPoint,
  ) => Effect.Effect<
    () => Effect.Effect<
      s3control.GetAccessPointPolicyStatusResult,
      s3control.GetAccessPointPolicyStatusError
    >
  >
> {}
export const GetAccessPointPolicyStatus =
  Binding.Service<GetAccessPointPolicyStatus>(
    "AWS.S3Control.GetAccessPointPolicyStatus",
  );
