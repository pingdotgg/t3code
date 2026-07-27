import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface BatchRemoveChannelRoleFromAccessorsRequest extends Omit<
  repostspace.BatchRemoveChannelRoleFromAccessorsInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `BatchRemoveChannelRoleFromAccessors` operation
 * (IAM action `repostspace:BatchRemoveChannelRoleFromAccessors` on the
 * space ARN).
 *
 * Removes a channel-level role from up to 100 users or groups in a channel
 * of the bound {@link Space}. Per-accessor failures are reported in the
 * output's `errors` list rather than failing the whole call.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.BatchRemoveChannelRoleFromAccessorsHttp)`.
 * @binding
 * @section Managing Roles
 * @example Remove a channel role from users
 * ```typescript
 * const removeChannelRole =
 *   yield* AWS.RePostSpace.BatchRemoveChannelRoleFromAccessors(space);
 *
 * const result = yield* removeChannelRole({
 *   channelId,
 *   accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
 *   channelRole: "EXPERT",
 * });
 * ```
 */
export interface BatchRemoveChannelRoleFromAccessors extends Binding.Service<
  BatchRemoveChannelRoleFromAccessors,
  "AWS.RePostSpace.BatchRemoveChannelRoleFromAccessors",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: BatchRemoveChannelRoleFromAccessorsRequest,
    ) => Effect.Effect<
      repostspace.BatchRemoveChannelRoleFromAccessorsOutput,
      repostspace.BatchRemoveChannelRoleFromAccessorsError
    >
  >
> {}
export const BatchRemoveChannelRoleFromAccessors =
  Binding.Service<BatchRemoveChannelRoleFromAccessors>(
    "AWS.RePostSpace.BatchRemoveChannelRoleFromAccessors",
  );
