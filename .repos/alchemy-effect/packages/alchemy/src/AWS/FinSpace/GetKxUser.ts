import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxUser` — reads one kdb user of the bound environment — user ARN and mapped IAM role.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxUserHttp)`.
 * @binding
 * @section Managing kdb Users
 * @example Read a User
 * ```typescript
 * const getUser = yield* AWS.FinSpace.GetKxUser(kdb);
 *
 * const { userArn, iamRole } = yield* getUser({ userName: "analyst" });
 * ```
 */
export interface GetKxUser extends Binding.Service<
  GetKxUser,
  "AWS.FinSpace.GetKxUser",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxUserRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxUserResponse, SVC.GetKxUserError>
  >
> {}
export const GetKxUser = Binding.Service<GetKxUser>("AWS.FinSpace.GetKxUser");
