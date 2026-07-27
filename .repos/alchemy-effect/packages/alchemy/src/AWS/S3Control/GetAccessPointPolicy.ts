import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AccessPoint } from "./AccessPoint.ts";

/**
 * Runtime binding for `s3:GetAccessPointPolicy`.
 *
 * Reads the resource policy attached to the bound {@link AccessPoint}. An
 * access point without a policy fails with the typed
 * `NoSuchAccessPointPolicy` tag. Provide the implementation with
 * `Effect.provide(AWS.S3Control.GetAccessPointPolicyHttp)`.
 * @binding
 * @section Observing an Access Point
 * @example Read the Access Point's Policy
 * ```typescript
 * // init — bind the operation to the access point
 * const getPolicy = yield* AWS.S3Control.GetAccessPointPolicy(accessPoint);
 *
 * // runtime
 * const policy = yield* getPolicy().pipe(
 *   Effect.catchTag("NoSuchAccessPointPolicy", () =>
 *     Effect.succeed({ Policy: undefined }),
 *   ),
 * );
 * ```
 */
export interface GetAccessPointPolicy extends Binding.Service<
  GetAccessPointPolicy,
  "AWS.S3Control.GetAccessPointPolicy",
  (
    accessPoint: AccessPoint,
  ) => Effect.Effect<
    () => Effect.Effect<
      s3control.GetAccessPointPolicyResult,
      s3control.GetAccessPointPolicyError
    >
  >
> {}
export const GetAccessPointPolicy = Binding.Service<GetAccessPointPolicy>(
  "AWS.S3Control.GetAccessPointPolicy",
);
