import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:ListUsers` — list the users in a face collection.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:ListUsers` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.ListUsersHttp)`.
 *
 * @binding
 * @section User Search
 * @example List Users in a Collection
 * ```typescript
 * // init
 * const listUsers = yield* AWS.Rekognition.ListUsers();
 *
 * // runtime
 * const page = yield* listUsers({ CollectionId: "tenant-42" });
 * const userIds = (page.Users ?? []).map((u) => u.UserId);
 * ```
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "AWS.Rekognition.ListUsers",
  () => Effect.Effect<
    (
      request: rekognition.ListUsersRequest,
    ) => Effect.Effect<
      rekognition.ListUsersResponse,
      rekognition.ListUsersError
    >
  >
> {}
export const ListUsers = Binding.Service<ListUsers>(
  "AWS.Rekognition.ListUsers",
);
