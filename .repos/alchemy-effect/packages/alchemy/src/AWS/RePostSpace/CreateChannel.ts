import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface CreateChannelRequest extends Omit<
  repostspace.CreateChannelInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `CreateChannel` operation (IAM action
 * `repostspace:CreateChannel` on the space ARN).
 *
 * Creates a channel — a topic-scoped area for questions and articles —
 * inside the bound {@link Space}. Channels are content organization and
 * cannot be deleted (the re:Post Private API has no `DeleteChannel`), so
 * they are modeled as a runtime capability rather than a Resource.
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.CreateChannelHttp)`.
 * @binding
 * @section Managing Channels
 * @example Create a channel in the private re:Post
 * ```typescript
 * const createChannel = yield* AWS.RePostSpace.CreateChannel(space);
 *
 * const { channelId } = yield* createChannel({
 *   channelName: "Networking",
 *   channelDescription: "VPC, DNS, and connectivity questions",
 * });
 * ```
 */
export interface CreateChannel extends Binding.Service<
  CreateChannel,
  "AWS.RePostSpace.CreateChannel",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request: CreateChannelRequest,
    ) => Effect.Effect<
      repostspace.CreateChannelOutput,
      repostspace.CreateChannelError
    >
  >
> {}
export const CreateChannel = Binding.Service<CreateChannel>(
  "AWS.RePostSpace.CreateChannel",
);
