import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:DeleteKxUser` — deletes a kdb user of the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.DeleteKxUserHttp)`.
 * @binding
 * @section Managing kdb Users
 * @example Delete a User
 * ```typescript
 * const deleteUser = yield* AWS.FinSpace.DeleteKxUser(kdb);
 *
 * yield* deleteUser({ userName: "analyst" });
 * ```
 */
export interface DeleteKxUser extends Binding.Service<
  DeleteKxUser,
  "AWS.FinSpace.DeleteKxUser",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.DeleteKxUserRequest, "environmentId">,
    ) => Effect.Effect<SVC.DeleteKxUserResponse, SVC.DeleteKxUserError>
  >
> {}
export const DeleteKxUser = Binding.Service<DeleteKxUser>(
  "AWS.FinSpace.DeleteKxUser",
);
