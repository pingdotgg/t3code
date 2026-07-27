import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PhoneNumber } from "./PhoneNumber.ts";

/**
 * The `OriginationIdentity` is injected by the binding from the bound
 * phone number; the caller supplies the destination and message body.
 */
export interface SendTextMessageRequest extends Omit<
  smsvoice.SendTextMessageRequest,
  "OriginationIdentity"
> {}

/**
 * Runtime binding for `sms-voice:SendTextMessage`.
 *
 * Sends an SMS message from the bound origination phone number to one
 * recipient — the effectful call made from a deployed Lambda or Task. The
 * deploy-time half grants `sms-voice:SendTextMessage` on the number and
 * the runtime half injects its ARN as the request's `OriginationIdentity`.
 * Provide the implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.SendTextMessageHttp)`.
 * @binding
 * @section Sending Text Messages
 * @example Send an SMS from a Lambda
 * ```typescript
 * // init — lease a number and bind the send operation
 * const number = yield* AWS.PinpointSMSVoiceV2.PhoneNumber("Sender", {
 *   isoCountryCode: "US",
 *   messageType: "TRANSACTIONAL",
 *   numberCapabilities: ["SMS"],
 *   numberType: "TOLL_FREE",
 * });
 * const sendText = yield* AWS.PinpointSMSVoiceV2.SendTextMessage(number);
 *
 * // runtime
 * const { MessageId } = yield* sendText({
 *   DestinationPhoneNumber: "+12065550100",
 *   MessageBody: "Your code is 123456",
 *   MessageType: "TRANSACTIONAL",
 * });
 * ```
 */
export interface SendTextMessage extends Binding.Service<
  SendTextMessage,
  "AWS.PinpointSMSVoiceV2.SendTextMessage",
  (
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<
    (
      request: SendTextMessageRequest,
    ) => Effect.Effect<
      smsvoice.SendTextMessageResult,
      smsvoice.SendTextMessageError
    >
  >
> {}
export const SendTextMessage = Binding.Service<SendTextMessage>(
  "AWS.PinpointSMSVoiceV2.SendTextMessage",
);
