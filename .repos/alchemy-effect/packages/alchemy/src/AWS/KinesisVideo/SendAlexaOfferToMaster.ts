import type * as kv from "@distilled.cloud/aws/kinesis-video";
import type * as kvs from "@distilled.cloud/aws/kinesis-video-signaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SignalingEndpointUnavailable } from "./internal.ts";
import type { SignalingChannel } from "./SignalingChannel.ts";

export interface SendAlexaOfferToMasterRequest extends Omit<
  kvs.SendAlexaOfferToMasterRequest,
  "ChannelARN"
> {}

/**
 * Runtime binding for `kinesisvideo:SendAlexaOfferToMaster` (WebRTC
 * signaling data plane).
 *
 * Bind this operation to a `SignalingChannel` inside a function runtime to
 * get a callable that resolves the per-channel HTTPS signaling endpoint
 * (`GetSignalingChannelEndpoint`) and delivers a base64-encoded SDP offer
 * from an Alexa display device to the connected master peer, returning the
 * master's SDP answer.
 *
 * If no master is connected the service holds the offer for redelivery
 * until the message TTL expires — bound the call with a timeout when the
 * master may be offline.
 * @binding
 * @section WebRTC Connectivity
 * @example Send an Alexa SDP Offer
 * ```typescript
 * // init
 * const sendOffer = yield* AWS.KinesisVideo.SendAlexaOfferToMaster(channel);
 *
 * // runtime
 * const { Answer } = yield* sendOffer({
 *   SenderClientId: "alexa-device-1",
 *   MessagePayload: base64SdpOffer,
 * });
 * ```
 */
export interface SendAlexaOfferToMaster extends Binding.Service<
  SendAlexaOfferToMaster,
  "AWS.KinesisVideo.SendAlexaOfferToMaster",
  <C extends SignalingChannel>(
    channel: C,
  ) => Effect.Effect<
    (
      request: SendAlexaOfferToMasterRequest,
    ) => Effect.Effect<
      kvs.SendAlexaOfferToMasterResponse,
      | kvs.SendAlexaOfferToMasterError
      | kv.GetSignalingChannelEndpointError
      | SignalingEndpointUnavailable
    >
  >
> {}

export const SendAlexaOfferToMaster = Binding.Service<SendAlexaOfferToMaster>(
  "AWS.KinesisVideo.SendAlexaOfferToMaster",
);
