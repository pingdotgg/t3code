import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvs from "@distilled.cloud/aws/kinesis-video-signaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SignalingEndpointUnavailable } from "./internal.ts";
import type { SignalingChannel } from "./SignalingChannel.ts";

export interface GetIceServerConfigRequest extends Omit<
  kvs.GetIceServerConfigRequest,
  "ChannelARN"
> {}

/**
 * Runtime binding for `kinesisvideo:GetIceServerConfig` (WebRTC signaling
 * data plane).
 *
 * Bind this operation to a `SignalingChannel` inside a function runtime to
 * get a callable that resolves the per-channel HTTPS signaling endpoint
 * (`GetSignalingChannelEndpoint`) and returns TURN server URIs with
 * short-lived credentials for establishing WebRTC connectivity.
 * @binding
 * @section WebRTC Connectivity
 * @example ICE Server Configuration
 * ```typescript
 * // init
 * const getIceServers = yield* AWS.KinesisVideo.GetIceServerConfig(channel);
 *
 * // runtime
 * const { IceServerList } = yield* getIceServers({ ClientId: "viewer-1" });
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Provide the GetIceServerConfigHttp layer on the Function's init Effect.
 * export default SignalingFunction.make(
 *   { main: import.meta.url, url: true, timeout: Duration.seconds(30) },
 *   Effect.gen(function* () {
 *     const channel = yield* AWS.KinesisVideo.SignalingChannel("Doorbell");
 *     const getIceServers = yield* AWS.KinesisVideo.GetIceServerConfig(channel);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { IceServerList } = yield* getIceServers({
 *           ClientId: "viewer-1",
 *         });
 *         return HttpServerResponse.json({ iceServers: IceServerList });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.KinesisVideo.GetIceServerConfigHttp)),
 * );
 * ```
 */
export interface GetIceServerConfig extends Binding.Service<
  GetIceServerConfig,
  "AWS.KinesisVideo.GetIceServerConfig",
  <C extends SignalingChannel>(
    channel: C,
  ) => Effect.Effect<
    (
      request?: GetIceServerConfigRequest,
    ) => Effect.Effect<
      kvs.GetIceServerConfigResponse,
      | kvs.GetIceServerConfigError
      | kv.GetSignalingChannelEndpointError
      | SignalingEndpointUnavailable
    >
  >
> {}

export const GetIceServerConfig = Binding.Service<GetIceServerConfig>(
  "AWS.KinesisVideo.GetIceServerConfig",
);
