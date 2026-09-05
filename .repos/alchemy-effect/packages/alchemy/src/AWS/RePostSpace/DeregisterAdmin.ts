import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface DeregisterAdminRequest extends Omit<
  repostspace.DeregisterAdminInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `DeregisterAdmin` operation (IAM action
 * `repostspace:DeregisterAdmin` on the space ARN).
 *
 * Removes administrator privileges from an IAM Identity Center user or
 * group (by accessor id) of the bound {@link Space}.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.DeregisterAdminHttp)`.
 * @binding
 * @section Managing Admins
 * @example Deregister a space administrator
 * ```typescript
 * const deregisterAdmin = yield* AWS.RePostSpace.DeregisterAdmin(space);
 *
 * yield* deregisterAdmin({ adminId: "94682c8d-1234-5678-9abc-e001c76e2c44" });
 * ```
 */
export interface DeregisterAdmin extends Binding.Service<
  DeregisterAdmin,
  "AWS.RePostSpace.DeregisterAdmin",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: DeregisterAdminRequest,
    ) => Effect.Effect<
      repostspace.DeregisterAdminResponse,
      repostspace.DeregisterAdminError
    >
  >
> {}
export const DeregisterAdmin = Binding.Service<DeregisterAdmin>(
  "AWS.RePostSpace.DeregisterAdmin",
);
