import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `DeleteUser` request with `applicationId` injected from the bound application.
 */
export interface DeleteUserRequest extends Omit<
  qbusiness.DeleteUserRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `DeleteUser` operation (IAM action
 * `qbusiness:DeleteUser`), scoped to one {@link Application}.
 *
 * Deletes a user from the application user store.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.DeleteUserHttp)`.
 *
 * @binding
 * @section User Management
 * @example Delete a User
 * ```typescript
 * const deleteUser = yield* AWS.QBusiness.DeleteUser(app);
 *
 * yield* deleteUser({ userId: "user@example.com" });
 * ```
 */
export interface DeleteUser extends Binding.Service<
  DeleteUser,
  "AWS.QBusiness.DeleteUser",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: DeleteUserRequest,
    ) => Effect.Effect<qbusiness.DeleteUserResponse, qbusiness.DeleteUserError>
  >
> {}
export const DeleteUser = Binding.Service<DeleteUser>(
  "AWS.QBusiness.DeleteUser",
);
