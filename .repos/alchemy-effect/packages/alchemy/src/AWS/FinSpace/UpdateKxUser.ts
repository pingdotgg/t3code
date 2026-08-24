import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:UpdateKxUser` — re-points a kdb user of the bound environment at a different IAM role.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.UpdateKxUserHttp)`.
 * @binding
 * @section Managing kdb Users
 * @example Rotate a User's Role
 * ```typescript
 * const updateUser = yield* AWS.FinSpace.UpdateKxUser(kdb);
 *
 * yield* updateUser({ userName: "analyst", iamRole: newRoleArn });
 * ```
 */
export interface UpdateKxUser extends Binding.Service<
  UpdateKxUser,
  "AWS.FinSpace.UpdateKxUser",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.UpdateKxUserRequest, "environmentId">,
    ) => Effect.Effect<SVC.UpdateKxUserResponse, SVC.UpdateKxUserError>
  >
> {}
export const UpdateKxUser = Binding.Service<UpdateKxUser>(
  "AWS.FinSpace.UpdateKxUser",
);
