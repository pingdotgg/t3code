import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * `GetUser` request with `applicationId` injected from the bound application.
 */
export interface GetUserRequest extends Omit<
  qbusiness.GetUserRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `GetUser` operation (IAM action
 * `qbusiness:GetUser`), scoped to one {@link Application}.
 *
 * Reads a user's alias mappings from the application user store.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.GetUserHttp)`.
 *
 * @binding
 * @section User Management
 * @example Read a User
 * ```typescript
 * const getUser = yield* AWS.QBusiness.GetUser(app);
 *
 * const { userAliases } = yield* getUser({ userId: "user@example.com" });
 * ```
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "AWS.QBusiness.GetUser",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetUserRequest,
    ) => Effect.Effect<qbusiness.GetUserResponse, qbusiness.GetUserError>
  >
> {}
export const GetUser = Binding.Service<GetUser>("AWS.QBusiness.GetUser");
