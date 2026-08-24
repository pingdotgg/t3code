import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link CreateWhatsAppMessageTemplateFromLibrary}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface CreateWhatsAppMessageTemplateFromLibraryRequest extends Omit<
  socialmessaging.CreateWhatsAppMessageTemplateFromLibraryInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:CreateWhatsAppMessageTemplateFromLibrary`.
 *
 * Creates a WhatsApp message template on the bound account from one of the
 * pre-approved templates in Meta's template library.
 *
 * The deploy-time half grants `social-messaging:CreateWhatsAppMessageTemplateFromLibrary` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.CreateWhatsAppMessageTemplateFromLibraryHttp)`.
 * @binding
 * @section Managing Message Templates
 * @example Create a Template from Meta's Library
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const createFromLibrary = yield* AWS.SocialMessaging.CreateWhatsAppMessageTemplateFromLibrary(account);
 *
 * // runtime
 * const { metaTemplateId } = yield* createFromLibrary({
 *   metaLibraryTemplate: {
 *     templateName: "order_shipped",
 *     libraryTemplateName: "shipment_confirmation",
 *     templateCategory: "UTILITY",
 *     templateLanguage: "en_US",
 *   },
 * });
 * ```
 */
export interface CreateWhatsAppMessageTemplateFromLibrary extends Binding.Service<
  CreateWhatsAppMessageTemplateFromLibrary,
  "AWS.SocialMessaging.CreateWhatsAppMessageTemplateFromLibrary",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: CreateWhatsAppMessageTemplateFromLibraryRequest,
    ) => Effect.Effect<
      socialmessaging.CreateWhatsAppMessageTemplateFromLibraryOutput,
      socialmessaging.CreateWhatsAppMessageTemplateFromLibraryError
    >
  >
> {}
export const CreateWhatsAppMessageTemplateFromLibrary =
  Binding.Service<CreateWhatsAppMessageTemplateFromLibrary>(
    "AWS.SocialMessaging.CreateWhatsAppMessageTemplateFromLibrary",
  );
