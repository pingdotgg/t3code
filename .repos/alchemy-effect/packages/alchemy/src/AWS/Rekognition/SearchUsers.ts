import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:SearchUsers` — search a face collection for users matching a face ID or user ID.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:SearchUsers` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.SearchUsersHttp)`.
 *
 * @binding
 * @section User Search
 * @example Search Users by Face ID
 * ```typescript
 * // init
 * const searchUsers = yield* AWS.Rekognition.SearchUsers();
 *
 * // runtime
 * const result = yield* searchUsers({
 *   CollectionId: "tenant-42",
 *   FaceId: faceId,
 * });
 * const matches = result.UserMatches ?? [];
 * ```
 */
export interface SearchUsers extends Binding.Service<
  SearchUsers,
  "AWS.Rekognition.SearchUsers",
  () => Effect.Effect<
    (
      request: rekognition.SearchUsersRequest,
    ) => Effect.Effect<
      rekognition.SearchUsersResponse,
      rekognition.SearchUsersError
    >
  >
> {}
export const SearchUsers = Binding.Service<SearchUsers>(
  "AWS.Rekognition.SearchUsers",
);
