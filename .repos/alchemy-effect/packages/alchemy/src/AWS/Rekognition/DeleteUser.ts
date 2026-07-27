import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DeleteUser` — delete a user from a face collection.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DeleteUser` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DeleteUserHttp)`.
 *
 * @binding
 * @section User Search
 * @example Delete a User
 * ```typescript
 * // init
 * const deleteUser = yield* AWS.Rekognition.DeleteUser();
 *
 * // runtime
 * yield* deleteUser({ CollectionId: "tenant-42", UserId: userId }).pipe(
 *   Effect.catchTag("ResourceNotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeleteUser extends Binding.Service<
  DeleteUser,
  "AWS.Rekognition.DeleteUser",
  () => Effect.Effect<
    (
      request: rekognition.DeleteUserRequest,
    ) => Effect.Effect<
      rekognition.DeleteUserResponse,
      rekognition.DeleteUserError
    >
  >
> {}
export const DeleteUser = Binding.Service<DeleteUser>(
  "AWS.Rekognition.DeleteUser",
);
