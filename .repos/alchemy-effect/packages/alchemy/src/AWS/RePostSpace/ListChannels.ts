import type * as repostspace from "@distilled.cloud/aws/repostspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Space } from "./Space.ts";

export interface ListChannelsRequest extends Omit<
  repostspace.ListChannelsInput,
  "spaceId"
> {}

/**
 * Runtime binding for the `ListChannels` operation (IAM action
 * `repostspace:ListChannels` on the space ARN).
 *
 * Lists the channels of the bound {@link Space}, one page per call
 * (`nextToken`/`maxResults`).
 * Provide the implementation with
 * `Effect.provide(AWS.RePostSpace.ListChannelsHttp)`.
 * @binding
 * @section Managing Channels
 * @example List the space's channels
 * ```typescript
 * const listChannels = yield* AWS.RePostSpace.ListChannels(space);
 *
 * const { channels } = yield* listChannels();
 * ```
 */
export interface ListChannels extends Binding.Service<
  ListChannels,
  "AWS.RePostSpace.ListChannels",
  (
    space: Space,
  ) => Effect.Effect<
    (
      request?: ListChannelsRequest,
    ) => Effect.Effect<
      repostspace.ListChannelsOutput,
      repostspace.ListChannelsError
    >
  >
> {}
export const ListChannels = Binding.Service<ListChannels>(
  "AWS.RePostSpace.ListChannels",
);
