import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

export interface GetStreamSessionRequest extends Omit<
  ivs.GetStreamSessionRequest,
  "channelArn"
> {}

/**
 * Runtime binding for `ivs:GetStreamSession`.
 *
 * Reads the metadata of a specific stream session on the bound
 * {@link Channel} — ingest configuration, recording details, and the
 * session's truncated event log. Omit `streamId` to read the most recent
 * session. The channel ARN is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.IVS.GetStreamSessionHttp)`.
 * @binding
 * @section Monitoring Live Streams
 * @example Inspect the Latest Broadcast Session
 * ```typescript
 * // init — bind the operation to the channel
 * const getStreamSession = yield* AWS.IVS.GetStreamSession(channel);
 *
 * // runtime
 * const { streamSession } = yield* getStreamSession({});
 * yield* Effect.log(`codec: ${streamSession?.ingestConfiguration?.video?.codec}`);
 * ```
 */
export interface GetStreamSession extends Binding.Service<
  GetStreamSession,
  "AWS.IVS.GetStreamSession",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request?: GetStreamSessionRequest,
    ) => Effect.Effect<ivs.GetStreamSessionResponse, ivs.GetStreamSessionError>
  >
> {}
export const GetStreamSession = Binding.Service<GetStreamSession>(
  "AWS.IVS.GetStreamSession",
);
