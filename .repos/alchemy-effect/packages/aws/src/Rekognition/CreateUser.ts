import type * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `rekognition:CreateUser` — create a user in a face collection to aggregate multiple face IDs of the same person.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:CreateUser` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.CreateUserHttp)`.
 *
 * ### User Search
 * **Example:** Create a User
 * ```typescript
 * // init
 * const createUser = yield* AWS.Rekognition.CreateUser();
 *
 * // runtime
 * yield* createUser({ CollectionId: "tenant-42", UserId: userId });
 * ```
 *
 * @binding
 */
export interface CreateUser extends Binding.Service<
  CreateUser,
  "AWS.Rekognition.CreateUser",
  () => Effect.Effect<
    (
      request: rekognition.CreateUserRequest,
    ) => Effect.Effect<rekognition.CreateUserResponse, rekognition.CreateUserError>
  >
> {}
export const CreateUser = Binding.Service<CreateUser>("AWS.Rekognition.CreateUser");
