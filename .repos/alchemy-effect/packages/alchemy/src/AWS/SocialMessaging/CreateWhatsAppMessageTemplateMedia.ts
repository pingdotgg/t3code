import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link CreateWhatsAppMessageTemplateMedia}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface CreateWhatsAppMessageTemplateMediaRequest extends Omit<
  socialmessaging.CreateWhatsAppMessageTemplateMediaInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:CreateWhatsAppMessageTemplateMedia`.
 *
 * Uploads media (from S3) for use in a WhatsApp message template header and
 * returns the Meta header handle to reference from the template definition.
 *
 * The deploy-time half grants `social-messaging:CreateWhatsAppMessageTemplateMedia` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.CreateWhatsAppMessageTemplateMediaHttp)`.
 * @binding
 * @section Managing Message Templates
 * @example Upload Template Header Media
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const uploadTemplateMedia = yield* AWS.SocialMessaging.CreateWhatsAppMessageTemplateMedia(account);
 *
 * // runtime
 * const { metaHeaderHandle } = yield* uploadTemplateMedia({
 *   sourceS3File: { bucketName: "my-assets", key: "header.png" },
 * });
 * ```
 */
export interface CreateWhatsAppMessageTemplateMedia extends Binding.Service<
  CreateWhatsAppMessageTemplateMedia,
  "AWS.SocialMessaging.CreateWhatsAppMessageTemplateMedia",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: CreateWhatsAppMessageTemplateMediaRequest,
    ) => Effect.Effect<
      socialmessaging.CreateWhatsAppMessageTemplateMediaOutput,
      socialmessaging.CreateWhatsAppMessageTemplateMediaError
    >
  >
> {}
export const CreateWhatsAppMessageTemplateMedia =
  Binding.Service<CreateWhatsAppMessageTemplateMedia>(
    "AWS.SocialMessaging.CreateWhatsAppMessageTemplateMedia",
  );
