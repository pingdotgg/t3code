import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvws from "@distilled.cloud/aws/kinesis-video-webrtc-storage";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SignalingEndpointUnavailable } from "./internal.ts";
import type { SignalingChannel } from "./SignalingChannel.ts";

/**
 * Runtime binding for `kinesisvideo:JoinStorageSession` (WebRTC storage
 * data plane).
 *
 * Bind this operation to a `SignalingChannel` inside a function runtime to
 * get a callable that resolves the per-channel WEBRTC storage endpoint
 * (`GetSignalingChannelEndpoint`) and joins the ongoing WebRTC session as
 * the video-producing master so the media is recorded into the channel's
 * associated Kinesis Video stream.
 *
 * Requires the channel's media storage to be configured (an ENABLED
 * `MediaStorageConfiguration` linking the channel to a stream); without it
 * the endpoint discovery fails with the typed `SignalingEndpointUnavailable`
 * error.
 * @binding
 * @section WebRTC Storage
 * @example Join a Storage Session as Master
 * ```typescript
 * // init
 * const joinStorage = yield* AWS.KinesisVideo.JoinStorageSession(channel);
 *
 * // runtime
 * yield* joinStorage();
 * ```
 */
export interface JoinStorageSession extends Binding.Service<
  JoinStorageSession,
  "AWS.KinesisVideo.JoinStorageSession",
  <C extends SignalingChannel>(
    channel: C,
  ) => Effect.Effect<
    () => Effect.Effect<
      kvws.JoinStorageSessionResponse,
      | kvws.JoinStorageSessionError
      | kv.GetSignalingChannelEndpointError
      | SignalingEndpointUnavailable
    >
  >
> {}

export const JoinStorageSession = Binding.Service<JoinStorageSession>(
  "AWS.KinesisVideo.JoinStorageSession",
);
