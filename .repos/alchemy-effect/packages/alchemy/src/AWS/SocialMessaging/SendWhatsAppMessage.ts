import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Runtime binding for `social-messaging:SendWhatsAppMessage`.
 *
 * Sends a WhatsApp message (text, template, media, or interactive) from one
 * of the linked account's phone numbers. The `message` blob is the raw Meta
 * Cloud API message payload and is sensitive — pass it as a `Uint8Array` or
 * `Redacted<Uint8Array>`.
 *
 * The caller addresses one of the bound account's phone numbers per
 * request; phone-number ARNs are provisioned by Meta under the WABA, so
 * the deploy-time half grants `social-messaging:SendWhatsAppMessage` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.SendWhatsAppMessageHttp)`.
 * @binding
 * @section Sending Messages
 * @example Send a Text Message
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const sendMessage = yield* AWS.SocialMessaging.SendWhatsAppMessage(account);
 *
 * // runtime
 * const { messageId } = yield* sendMessage({
 *   originationPhoneNumberId: "phone-number-id-0123456789abcdef",
 *   metaApiVersion: "v20.0",
 *   message: new TextEncoder().encode(
 *     JSON.stringify({
 *       messaging_product: "whatsapp",
 *       to: "+12065550100",
 *       type: "text",
 *       text: { body: "Hello from Alchemy" },
 *     }),
 *   ),
 * });
 * ```
 */
export interface SendWhatsAppMessage extends Binding.Service<
  SendWhatsAppMessage,
  "AWS.SocialMessaging.SendWhatsAppMessage",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: socialmessaging.SendWhatsAppMessageInput,
    ) => Effect.Effect<
      socialmessaging.SendWhatsAppMessageOutput,
      socialmessaging.SendWhatsAppMessageError
    >
  >
> {}
export const SendWhatsAppMessage = Binding.Service<SendWhatsAppMessage>(
  "AWS.SocialMessaging.SendWhatsAppMessage",
);
