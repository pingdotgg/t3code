import type * as efs from "@distilled.cloud/aws/efs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteAccessPoint` operation (IAM action
 * `elasticfilesystem:DeleteAccessPoint`).
 *
 * Deletes an access point by ID — the teardown half of the runtime
 * multi-tenant pattern built with {@link CreateAccessPoint}. The action
 * authorizes on the access point's own ARN, which for runtime-created
 * access points is unknowable at deploy time, so the grant is on `*`.
 * Deleting an already-deleted access point surfaces the typed
 * `AccessPointNotFound`. Provide the implementation with
 * `Effect.provide(AWS.EFS.DeleteAccessPointHttp)`.
 * @binding
 * @section Managing Access Points at Runtime
 * @example Delete a tenant's access point
 * ```typescript
 * const deleteAccessPoint = yield* AWS.EFS.DeleteAccessPoint();
 *
 * yield* deleteAccessPoint({ AccessPointId: accessPointId }).pipe(
 *   Effect.catchTag("AccessPointNotFound", () => Effect.void),
 * );
 * ```
 */
export interface DeleteAccessPoint extends Binding.Service<
  DeleteAccessPoint,
  "AWS.EFS.DeleteAccessPoint",
  () => Effect.Effect<
    (
      request: efs.DeleteAccessPointRequest,
    ) => Effect.Effect<
      efs.DeleteAccessPointResponse,
      efs.DeleteAccessPointError
    >
  >
> {}
export const DeleteAccessPoint = Binding.Service<DeleteAccessPoint>(
  "AWS.EFS.DeleteAccessPoint",
);
