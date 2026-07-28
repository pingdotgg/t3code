import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvws from "@distilled.cloud/aws/kinesis-video-webrtc-storage";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SignalingEndpointUnavailable } from "./internal.ts";
import type { SignalingChannel } from "./SignalingChannel.ts";

export interface JoinStorageSessionAsViewerRequest extends Omit<
  kvws.JoinStorageSessionAsViewerInput,
  "channelArn"
> {}

/**
 * Runtime binding for `kinesisvideo:JoinStorageSessionAsViewer` (WebRTC
 * storage data plane).
 *
 * Bind this operation to a `SignalingChannel` inside a function runtime to
 * get a callable that resolves the per-channel WEBRTC storage endpoint
 * (`GetSignalingChannelEndpoint`) and joins the ongoing WebRTC session as
 * a viewer, identified by `clientId`.
 *
 * Requires the channel's media storage to be configured (an ENABLED
 * `MediaStorageConfiguration` linking the channel to a stream); without it
 * the endpoint discovery fails with the typed `SignalingEndpointUnavailable`
 * error.
 * @binding
 * @section WebRTC Storage
 * @example Join a Storage Session as Viewer
 * ```typescript
 * // init
 * const joinAsViewer =
 *   yield* AWS.KinesisVideo.JoinStorageSessionAsViewer(channel);
 *
 * // runtime
 * yield* joinAsViewer({ clientId: "viewer-1" });
 * ```
 */
export interface JoinStorageSessionAsViewer extends Binding.Service<
  JoinStorageSessionAsViewer,
  "AWS.KinesisVideo.JoinStorageSessionAsViewer",
  <C extends SignalingChannel>(
    channel: C,
  ) => Effect.Effect<
    (
      request: JoinStorageSessionAsViewerRequest,
    ) => Effect.Effect<
      kvws.JoinStorageSessionAsViewerResponse,
      | kvws.JoinStorageSessionAsViewerError
      | kv.GetSignalingChannelEndpointError
      | SignalingEndpointUnavailable
    >
  >
> {}

export const JoinStorageSessionAsViewer =
  Binding.Service<JoinStorageSessionAsViewer>(
    "AWS.KinesisVideo.JoinStorageSessionAsViewer",
  );
