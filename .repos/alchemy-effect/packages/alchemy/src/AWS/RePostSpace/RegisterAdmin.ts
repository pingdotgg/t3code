import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface RegisterAdminRequest extends Omit<
  repostspace.RegisterAdminInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `RegisterAdmin` operation (IAM action
 * `repostspace:RegisterAdmin` on the space ARN).
 *
 * Promotes an IAM Identity Center user or group (by accessor id) to
 * administrator of the bound {@link Space}.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.RegisterAdminHttp)`.
 * @binding
 * @section Managing Admins
 * @example Register a space administrator
 * ```typescript
 * const registerAdmin = yield* AWS.RePostSpace.RegisterAdmin(space);
 *
 * yield* registerAdmin({ adminId: "94682c8d-1234-5678-9abc-e001c76e2c44" });
 * ```
 */
export interface RegisterAdmin extends Binding.Service<
  RegisterAdmin,
  "AWS.RePostSpace.RegisterAdmin",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: RegisterAdminRequest,
    ) => Effect.Effect<
      repostspace.RegisterAdminResponse,
      repostspace.RegisterAdminError
    >
  >
> {}
export const RegisterAdmin = Binding.Service<RegisterAdmin>(
  "AWS.RePostSpace.RegisterAdmin",
);
