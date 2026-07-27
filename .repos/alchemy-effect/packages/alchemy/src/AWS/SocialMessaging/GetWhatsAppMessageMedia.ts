import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Runtime binding for `social-messaging:GetWhatsAppMessageMedia`.
 *
 * Retrieves a media file received in a WhatsApp message — either just its
 * metadata (`metadataOnly: true`) or a full download into an S3 object or
 * presigned URL.
 *
 * The caller addresses one of the bound account's phone numbers per
 * request; phone-number ARNs are provisioned by Meta under the WABA, so
 * the deploy-time half grants `social-messaging:GetWhatsAppMessageMedia` on `*`.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.GetWhatsAppMessageMediaHttp)`.
 * @binding
 * @section Managing Message Media
 * @example Download Received Media to S3
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const getMedia = yield* AWS.SocialMessaging.GetWhatsAppMessageMedia(account);
 *
 * // runtime
 * const { mimeType, fileSize } = yield* getMedia({
 *   mediaId: "media-id-from-inbound-event",
 *   originationPhoneNumberId: "phone-number-id-0123456789abcdef",
 *   destinationS3File: { bucketName: "my-inbox", key: "media/inbound" },
 * });
 * ```
 */
export interface GetWhatsAppMessageMedia extends Binding.Service<
  GetWhatsAppMessageMedia,
  "AWS.SocialMessaging.GetWhatsAppMessageMedia",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: socialmessaging.GetWhatsAppMessageMediaInput,
    ) => Effect.Effect<
      socialmessaging.GetWhatsAppMessageMediaOutput,
      socialmessaging.GetWhatsAppMessageMediaError
    >
  >
> {}
export const GetWhatsAppMessageMedia = Binding.Service<GetWhatsAppMessageMedia>(
  "AWS.SocialMessaging.GetWhatsAppMessageMedia",
);
