import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link DeleteWhatsAppMessageTemplate}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface DeleteWhatsAppMessageTemplateRequest extends Omit<
  socialmessaging.DeleteWhatsAppMessageTemplateInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:DeleteWhatsAppMessageTemplate`.
 *
 * Deletes a WhatsApp message template from the bound account, optionally
 * across all of its languages.
 *
 * The deploy-time half grants `social-messaging:DeleteWhatsAppMessageTemplate` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.DeleteWhatsAppMessageTemplateHttp)`.
 * @binding
 * @section Managing Message Templates
 * @example Delete a Template
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const deleteTemplate = yield* AWS.SocialMessaging.DeleteWhatsAppMessageTemplate(account);
 *
 * // runtime
 * yield* deleteTemplate({
 *   templateName: "order_update",
 *   deleteAllLanguages: true,
 * });
 * ```
 */
export interface DeleteWhatsAppMessageTemplate extends Binding.Service<
  DeleteWhatsAppMessageTemplate,
  "AWS.SocialMessaging.DeleteWhatsAppMessageTemplate",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: DeleteWhatsAppMessageTemplateRequest,
    ) => Effect.Effect<
      socialmessaging.DeleteWhatsAppMessageTemplateOutput,
      socialmessaging.DeleteWhatsAppMessageTemplateError
    >
  >
> {}
export const DeleteWhatsAppMessageTemplate =
  Binding.Service<DeleteWhatsAppMessageTemplate>(
    "AWS.SocialMessaging.DeleteWhatsAppMessageTemplate",
  );
