import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Runtime binding for `social-messaging:DeleteWhatsAppMessageMedia`.
 *
 * Deletes a media file previously uploaded to WhatsApp from the given phone
 * number.
 *
 * The caller addresses one of the bound account's phone numbers per
 * request; phone-number ARNs are provisioned by Meta under the WABA, so
 * the deploy-time half grants `social-messaging:DeleteWhatsAppMessageMedia` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.DeleteWhatsAppMessageMediaHttp)`.
 * @binding
 * @section Managing Message Media
 * @example Delete Uploaded Media
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const deleteMedia = yield* AWS.SocialMessaging.DeleteWhatsAppMessageMedia(account);
 *
 * // runtime
 * const { success } = yield* deleteMedia({
 *   mediaId: "media-id-to-delete",
 *   originationPhoneNumberId: "phone-number-id-0123456789abcdef",
 * });
 * ```
 */
export interface DeleteWhatsAppMessageMedia extends Binding.Service<
  DeleteWhatsAppMessageMedia,
  "AWS.SocialMessaging.DeleteWhatsAppMessageMedia",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: socialmessaging.DeleteWhatsAppMessageMediaInput,
    ) => Effect.Effect<
      socialmessaging.DeleteWhatsAppMessageMediaOutput,
      socialmessaging.DeleteWhatsAppMessageMediaError
    >
  >
> {}
export const DeleteWhatsAppMessageMedia =
  Binding.Service<DeleteWhatsAppMessageMedia>(
    "AWS.SocialMessaging.DeleteWhatsAppMessageMedia",
  );
