import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PhoneNumber } from "./PhoneNumber.ts";

/**
 * The `OriginationIdentity` is injected by the binding from the bound
 * phone number; the caller supplies the destination and message body.
 */
export interface SendVoiceMessageRequest extends Omit<
  smsvoice.SendVoiceMessageRequest,
  "OriginationIdentity"
> {}

/**
 * Runtime binding for `sms-voice:SendVoiceMessage`.
 *
 * Sends a voice message from the bound origination phone number — Amazon
 * Polly converts the text (or SSML) `MessageBody` into speech. The
 * deploy-time half grants `sms-voice:SendVoiceMessage` on the number and
 * the runtime half injects its ARN as the request's `OriginationIdentity`.
 * The bound number must carry the `VOICE` capability. Provide the
 * implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.SendVoiceMessageHttp)`.
 * @binding
 * @section Sending Voice Messages
 * @example Call a Recipient with a Spoken Message
 * ```typescript
 * // init
 * const sendVoice = yield* AWS.PinpointSMSVoiceV2.SendVoiceMessage(number);
 *
 * // runtime
 * const { MessageId } = yield* sendVoice({
 *   DestinationPhoneNumber: "+12065550100",
 *   MessageBody: "Your appointment is confirmed for tomorrow at nine A M.",
 *   MessageBodyTextType: "TEXT",
 *   VoiceId: "JOANNA",
 * });
 * ```
 */
export interface SendVoiceMessage extends Binding.Service<
  SendVoiceMessage,
  "AWS.PinpointSMSVoiceV2.SendVoiceMessage",
  (
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<
    (
      request: SendVoiceMessageRequest,
    ) => Effect.Effect<
      smsvoice.SendVoiceMessageResult,
      smsvoice.SendVoiceMessageError
    >
  >
> {}
export const SendVoiceMessage = Binding.Service<SendVoiceMessage>(
  "AWS.PinpointSMSVoiceV2.SendVoiceMessage",
);
