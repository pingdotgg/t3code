import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface BatchAddRoleRequest extends Omit<
  repostspace.BatchAddRoleInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `BatchAddRole` operation (IAM action
 * `repostspace:BatchAddRole` on the space ARN).
 *
 * Grants a space-level role (`EXPERT`, `MODERATOR`, `ADMINISTRATOR`, or
 * `SUPPORTREQUESTOR`) to up to 100 users or groups of the bound
 * {@link Space} in one call. Per-accessor failures are reported in the
 * output's `errors` list rather than failing the whole call.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.BatchAddRoleHttp)`.
 * @binding
 * @section Managing Roles
 * @example Grant the EXPERT role to users
 * ```typescript
 * const batchAddRole = yield* AWS.RePostSpace.BatchAddRole(space);
 *
 * const result = yield* batchAddRole({
 *   accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
 *   role: "EXPERT",
 * });
 * console.log(result.addedAccessorIds, result.errors);
 * ```
 */
export interface BatchAddRole extends Binding.Service<
  BatchAddRole,
  "AWS.RePostSpace.BatchAddRole",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: BatchAddRoleRequest,
    ) => Effect.Effect<
      repostspace.BatchAddRoleOutput,
      repostspace.BatchAddRoleError
    >
  >
> {}
export const BatchAddRole = Binding.Service<BatchAddRole>(
  "AWS.RePostSpace.BatchAddRole",
);
