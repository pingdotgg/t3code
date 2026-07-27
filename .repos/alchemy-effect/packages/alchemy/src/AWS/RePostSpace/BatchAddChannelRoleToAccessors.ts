import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface BatchAddChannelRoleToAccessorsRequest extends Omit<
  repostspace.BatchAddChannelRoleToAccessorsInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `BatchAddChannelRoleToAccessors` operation (IAM
 * action `repostspace:BatchAddChannelRoleToAccessors` on the space ARN).
 *
 * Grants a channel-level role (`ASKER`, `EXPERT`, `MODERATOR`, or
 * `SUPPORTREQUESTOR`) to up to 100 users or groups in a channel of the
 * bound {@link Space}. Per-accessor failures are reported in the output's
 * `errors` list rather than failing the whole call.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.BatchAddChannelRoleToAccessorsHttp)`.
 * @binding
 * @section Managing Roles
 * @example Grant a channel role to users
 * ```typescript
 * const addChannelRole =
 *   yield* AWS.RePostSpace.BatchAddChannelRoleToAccessors(space);
 *
 * const result = yield* addChannelRole({
 *   channelId,
 *   accessorIds: ["94682c8d-1234-5678-9abc-e001c76e2c44"],
 *   channelRole: "EXPERT",
 * });
 * ```
 */
export interface BatchAddChannelRoleToAccessors extends Binding.Service<
  BatchAddChannelRoleToAccessors,
  "AWS.RePostSpace.BatchAddChannelRoleToAccessors",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: BatchAddChannelRoleToAccessorsRequest,
    ) => Effect.Effect<
      repostspace.BatchAddChannelRoleToAccessorsOutput,
      repostspace.BatchAddChannelRoleToAccessorsError
    >
  >
> {}
export const BatchAddChannelRoleToAccessors =
  Binding.Service<BatchAddChannelRoleToAccessors>(
    "AWS.RePostSpace.BatchAddChannelRoleToAccessors",
  );
