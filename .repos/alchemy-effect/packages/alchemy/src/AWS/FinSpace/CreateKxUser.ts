import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:CreateKxUser` — creates a kdb user in the bound environment, mapping an IAM role to a kdb identity.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.CreateKxUserHttp)`.
 * @binding
 * @section Managing kdb Users
 * @example Create a User
 * ```typescript
 * const createUser = yield* AWS.FinSpace.CreateKxUser(kdb);
 *
 * const user = yield* createUser({
 *   userName: "analyst",
 *   iamRole: roleArn,
 * });
 * ```
 */
export interface CreateKxUser extends Binding.Service<
  CreateKxUser,
  "AWS.FinSpace.CreateKxUser",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.CreateKxUserRequest, "environmentId">,
    ) => Effect.Effect<SVC.CreateKxUserResponse, SVC.CreateKxUserError>
  >
> {}
export const CreateKxUser = Binding.Service<CreateKxUser>(
  "AWS.FinSpace.CreateKxUser",
);
