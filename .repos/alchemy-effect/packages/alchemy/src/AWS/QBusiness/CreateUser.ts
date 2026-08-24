import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `CreateUser` request with `applicationId` injected from the bound application.
 */
export interface CreateUserRequest extends Omit<
  qbusiness.CreateUserRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `CreateUser` operation (IAM action
 * `qbusiness:CreateUser`), scoped to one {@link Application}.
 *
 * Creates a user in the application's user store, mapping the user
 * id to data-source-specific aliases used for document access
 * control.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.CreateUserHttp)`.
 *
 * @binding
 * @section User Management
 * @example Create a User with Aliases
 * ```typescript
 * const createUser = yield* AWS.QBusiness.CreateUser(app);
 *
 * yield* createUser({
 *   userId: "user@example.com",
 *   userAliases: [{ userId: "corp\\user" }],
 * });
 * ```
 */
export interface CreateUser extends Binding.Service<
  CreateUser,
  "AWS.QBusiness.CreateUser",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: CreateUserRequest,
    ) => Effect.Effect<qbusiness.CreateUserResponse, qbusiness.CreateUserError>
  >
> {}
export const CreateUser = Binding.Service<CreateUser>(
  "AWS.QBusiness.CreateUser",
);
