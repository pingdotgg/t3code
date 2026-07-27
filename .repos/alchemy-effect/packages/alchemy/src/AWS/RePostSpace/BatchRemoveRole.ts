import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface BatchRemoveRoleRequest extends Omit<
  repostspace.BatchRemoveRoleInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `BatchRemoveRole` operation (IAM action
 * `repostspace:BatchRemoveRole` on the space ARN).
 *
 * Removes a space-level role from up to 100 users or groups of the bound
 * {@link Space} in one call. Per-accessor failures are reported in the
 * output's `errors` list rather than failing the whole call.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.BatchRemoveRoleHttp)`.
 * @binding
 * @section Managing Roles
 * @example Remove the EXPERT role from users
 * ```typescript
 * const batchRemoveRole = yield* AWS.RePostSpace.BatchRemoveRole(space);
 *
 * const result = yield* batchRemoveRole({
 *   accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
 *   role: "EXPERT",
 * });
 * console.log(result.removedAccessorIds, result.errors);
 * ```
 */
export interface BatchRemoveRole extends Binding.Service<
  BatchRemoveRole,
  "AWS.RePostSpace.BatchRemoveRole",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: BatchRemoveRoleRequest,
    ) => Effect.Effect<
      repostspace.BatchRemoveRoleOutput,
      repostspace.BatchRemoveRoleError
    >
  >
> {}
export const BatchRemoveRole = Binding.Service<BatchRemoveRole>(
  "AWS.RePostSpace.BatchRemoveRole",
);
