import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:CreateUser` — create a user in a face collection to aggregate multiple face IDs of the same person.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:CreateUser` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.CreateUserHttp)`.
 *
 * @binding
 * @section User Search
 * @example Create a User
 * ```typescript
 * // init
 * const createUser = yield* AWS.Rekognition.CreateUser();
 *
 * // runtime
 * yield* createUser({ CollectionId: "tenant-42", UserId: userId });
 * ```
 */
export interface CreateUser extends Binding.Service<
  CreateUser,
  "AWS.Rekognition.CreateUser",
  () => Effect.Effect<
    (
      request: rekognition.CreateUserRequest,
    ) => Effect.Effect<
      rekognition.CreateUserResponse,
      rekognition.CreateUserError
    >
  >
> {}
export const CreateUser = Binding.Service<CreateUser>(
  "AWS.Rekognition.CreateUser",
);
