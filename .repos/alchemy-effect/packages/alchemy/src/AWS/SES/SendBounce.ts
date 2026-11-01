import type * as ses from "@distilled.cloud/aws/ses";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ses:SendBounce` (classic SES).
 *
 * Generates and sends a bounce message to the sender of an email you received
 * through SES receiving — the data-plane counterpart to `SES.ReceiptRule`
 * inbound processing. You can only bounce a message within 24 hours of
 * receiving it, and only for mail SES actually received.
 *
 * Account-level operation with no resource-level IAM scoping. Provide the
 * implementation with `Effect.provide(AWS.SES.SendBounceHttp)`.
 * ### Bouncing Inbound Mail
 * **Example:** Bounce a Received Message
 * ```typescript
 * // init — account-level binding, no resource argument
 * const sendBounce = yield* SES.SendBounce();
 *
 * // runtime — inside the Lambda that a ReceiptRule invokes
 * yield* sendBounce({
 *   OriginalMessageId: messageId,
 *   BounceSender: "mailer-daemon@example.com",
 *   BouncedRecipientInfoList: [
 *     {
 *       Recipient: "nobody@example.com",
 *       BounceType: "DoesNotExist",
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface SendBounce extends Binding.Service<
  SendBounce,
  "AWS.SES.SendBounce",
  () => Effect.Effect<
    (
      request: ses.SendBounceRequest,
    ) => Effect.Effect<ses.SendBounceResponse, ses.SendBounceError>
  >
> {}
export const SendBounce = Binding.Service<SendBounce>("AWS.SES.SendBounce");
