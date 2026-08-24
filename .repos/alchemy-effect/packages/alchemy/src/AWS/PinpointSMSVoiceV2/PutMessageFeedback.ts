import type * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sms-voice:PutMessageFeedback`.
 *
 * Marks a sent message's feedback record as `RECEIVED` or `FAILED`. When
 * a message is sent with `MessageFeedbackEnabled: true`, End User
 * Messaging SMS waits for this signal — set `RECEIVED` when your
 * application observes the user acting on the message (e.g. entering the
 * one-time passcode); records not updated within an hour are marked
 * `FAILED`. Account-level: feedback acts on message IDs, so the
 * deploy-time grant is `sms-voice:PutMessageFeedback` on `*`. Provide
 * the implementation with
 * `Effect.provide(AWS.PinpointSMSVoiceV2.PutMessageFeedbackHttp)`.
 * @binding
 * @section Message Feedback
 * @example Confirm an OTP Was Used
 * ```typescript
 * // init — bind the account-level operation
 * const putFeedback = yield* AWS.PinpointSMSVoiceV2.PutMessageFeedback();
 *
 * // runtime — after the user enters the code sent in `MessageId`
 * yield* putFeedback({
 *   MessageId: messageId,
 *   MessageFeedbackStatus: "RECEIVED",
 * });
 * ```
 */
export interface PutMessageFeedback extends Binding.Service<
  PutMessageFeedback,
  "AWS.PinpointSMSVoiceV2.PutMessageFeedback",
  () => Effect.Effect<
    (
      request: smsvoice.PutMessageFeedbackRequest,
    ) => Effect.Effect<
      smsvoice.PutMessageFeedbackResult,
      smsvoice.PutMessageFeedbackError
    >
  >
> {}
export const PutMessageFeedback = Binding.Service<PutMessageFeedback>(
  "AWS.PinpointSMSVoiceV2.PutMessageFeedback",
);
