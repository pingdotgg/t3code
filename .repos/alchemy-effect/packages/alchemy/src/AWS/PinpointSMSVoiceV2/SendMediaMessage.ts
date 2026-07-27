import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PhoneNumber } from "./PhoneNumber.ts";

/**
 * The `OriginationIdentity` is injected by the binding from the bound
 * phone number; the caller supplies the destination, body, and media URLs.
 */
export interface SendMediaMessageRequest extends Omit<
  smsvoice.SendMediaMessageRequest,
  "OriginationIdentity"
> {}

/**
 * Runtime binding for `sms-voice:SendMediaMessage`.
 *
 * Sends a multimedia message (MMS) from the bound origination phone
 * number. `MediaUrls` reference S3 objects (`s3://bucket/key`) holding the
 * attachments. The deploy-time half grants `sms-voice:SendMediaMessage` on
 * the number and the runtime half injects its ARN as the request's
 * `OriginationIdentity`. The bound number must carry the `MMS` capability.
 * Provide the implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.SendMediaMessageHttp)`.
 * @binding
 * @section Sending Media Messages
 * @example Send an MMS with an S3 Attachment
 * ```typescript
 * // init
 * const sendMedia = yield* AWS.PinpointSMSVoiceV2.SendMediaMessage(number);
 *
 * // runtime
 * const { MessageId } = yield* sendMedia({
 *   DestinationPhoneNumber: "+12065550100",
 *   MessageBody: "Here is your receipt",
 *   MediaUrls: ["s3://my-bucket/receipts/1234.png"],
 * });
 * ```
 */
export interface SendMediaMessage extends Binding.Service<
  SendMediaMessage,
  "AWS.PinpointSMSVoiceV2.SendMediaMessage",
  (
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<
    (
      request: SendMediaMessageRequest,
    ) => Effect.Effect<
      smsvoice.SendMediaMessageResult,
      smsvoice.SendMediaMessageError
    >
  >
> {}
export const SendMediaMessage = Binding.Service<SendMediaMessage>(
  "AWS.PinpointSMSVoiceV2.SendMediaMessage",
);
