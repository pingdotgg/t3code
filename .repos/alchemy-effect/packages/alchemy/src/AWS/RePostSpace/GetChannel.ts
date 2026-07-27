import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface GetChannelRequest extends Omit<
  repostspace.GetChannelInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `GetChannel` operation (IAM action
 * `repostspace:GetChannel` on the space ARN).
 *
 * Reads a channel of the bound {@link Space} — its name, description,
 * status, and per-accessor channel roles.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.GetChannelHttp)`.
 * @binding
 * @section Managing Channels
 * @example Read a channel
 * ```typescript
 * const getChannel = yield* AWS.RePostSpace.GetChannel(space);
 *
 * const channel = yield* getChannel({ channelId });
 * console.log(channel.channelName, channel.channelStatus);
 * ```
 */
export interface GetChannel extends Binding.Service<
  GetChannel,
  "AWS.RePostSpace.GetChannel",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: GetChannelRequest,
    ) => Effect.Effect<
      repostspace.GetChannelOutput,
      repostspace.GetChannelError
    >
  >
> {}
export const GetChannel = Binding.Service<GetChannel>(
  "AWS.RePostSpace.GetChannel",
);
