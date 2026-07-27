import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

export interface ListStreamSessionsRequest extends Omit<
  ivs.ListStreamSessionsRequest,
  "channelArn"
> {}

/**
 * Runtime binding for `ivs:ListStreamSessions`.
 *
 * Enumerates current and previous broadcast sessions on the bound
 * {@link Channel} (most recent first). The channel ARN is injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.IVS.ListStreamSessionsHttp)`.
 * @binding
 * @section Monitoring Live Streams
 * @example List Recent Broadcasts
 * ```typescript
 * // init — bind the operation to the channel
 * const listStreamSessions = yield* AWS.IVS.ListStreamSessions(channel);
 *
 * // runtime
 * const { streamSessions } = yield* listStreamSessions({ maxResults: 10 });
 * yield* Effect.log(`sessions: ${streamSessions.length}`);
 * ```
 */
export interface ListStreamSessions extends Binding.Service<
  ListStreamSessions,
  "AWS.IVS.ListStreamSessions",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request?: ListStreamSessionsRequest,
    ) => Effect.Effect<
      ivs.ListStreamSessionsResponse,
      ivs.ListStreamSessionsError
    >
  >
> {}
export const ListStreamSessions = Binding.Service<ListStreamSessions>(
  "AWS.IVS.ListStreamSessions",
);
