import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Runtime binding for `social-messaging:PostWhatsAppMessageMedia`.
 *
 * Uploads a media file to WhatsApp (from an S3 object or presigned URL) so
 * it can be referenced by `mediaId` in outbound messages sent from the
 * given phone number.
 *
 * The caller addresses one of the bound account's phone numbers per
 * request; phone-number ARNs are provisioned by Meta under the WABA, so
 * the deploy-time half grants `social-messaging:PostWhatsAppMessageMedia` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.PostWhatsAppMessageMediaHttp)`.
 * @binding
 * @section Managing Message Media
 * @example Upload Media from S3
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const postMedia = yield* AWS.SocialMessaging.PostWhatsAppMessageMedia(account);
 *
 * // runtime
 * const { mediaId } = yield* postMedia({
 *   originationPhoneNumberId: "phone-number-id-0123456789abcdef",
 *   sourceS3File: { bucketName: "my-assets", key: "welcome.png" },
 * });
 * ```
 */
export interface PostWhatsAppMessageMedia extends Binding.Service<
  PostWhatsAppMessageMedia,
  "AWS.SocialMessaging.PostWhatsAppMessageMedia",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: socialmessaging.PostWhatsAppMessageMediaInput,
    ) => Effect.Effect<
      socialmessaging.PostWhatsAppMessageMediaOutput,
      socialmessaging.PostWhatsAppMessageMediaError
    >
  >
> {}
export const PostWhatsAppMessageMedia =
  Binding.Service<PostWhatsAppMessageMedia>(
    "AWS.SocialMessaging.PostWhatsAppMessageMedia",
  );
