import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface UpdateChannelRequest extends Omit<
  repostspace.UpdateChannelInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `UpdateChannel` operation (IAM action
 * `repostspace:UpdateChannel` on the space ARN).
 *
 * Renames a channel of the bound {@link Space} and/or updates its
 * description.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.UpdateChannelHttp)`.
 * @binding
 * @section Managing Channels
 * @example Rename a channel
 * ```typescript
 * const updateChannel = yield* AWS.RePostSpace.UpdateChannel(space);
 *
 * yield* updateChannel({
 *   channelId,
 *   channelName: "Networking & DNS",
 * });
 * ```
 */
export interface UpdateChannel extends Binding.Service<
  UpdateChannel,
  "AWS.RePostSpace.UpdateChannel",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: UpdateChannelRequest,
    ) => Effect.Effect<
      repostspace.UpdateChannelOutput,
      repostspace.UpdateChannelError
    >
  >
> {}
export const UpdateChannel = Binding.Service<UpdateChannel>(
  "AWS.RePostSpace.UpdateChannel",
);
