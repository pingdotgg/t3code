import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link UpdateWhatsAppMessageTemplate}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface UpdateWhatsAppMessageTemplateRequest extends Omit<
  socialmessaging.UpdateWhatsAppMessageTemplateInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:UpdateWhatsAppMessageTemplate`.
 *
 * Updates an existing WhatsApp message template on the bound account — its
 * category or component JSON. Edits re-enter Meta review.
 *
 * The deploy-time half grants `social-messaging:UpdateWhatsAppMessageTemplate` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.UpdateWhatsAppMessageTemplateHttp)`.
 * @binding
 * @section Managing Message Templates
 * @example Update a Template
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const updateTemplate = yield* AWS.SocialMessaging.UpdateWhatsAppMessageTemplate(account);
 *
 * // runtime
 * yield* updateTemplate({
 *   metaTemplateId: "1234567890",
 *   templateComponents: new TextEncoder().encode(
 *     JSON.stringify([{ type: "BODY", text: "Order {{1}} delivered." }]),
 *   ),
 * });
 * ```
 */
export interface UpdateWhatsAppMessageTemplate extends Binding.Service<
  UpdateWhatsAppMessageTemplate,
  "AWS.SocialMessaging.UpdateWhatsAppMessageTemplate",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: UpdateWhatsAppMessageTemplateRequest,
    ) => Effect.Effect<
      socialmessaging.UpdateWhatsAppMessageTemplateOutput,
      socialmessaging.UpdateWhatsAppMessageTemplateError
    >
  >
> {}
export const UpdateWhatsAppMessageTemplate =
  Binding.Service<UpdateWhatsAppMessageTemplate>(
    "AWS.SocialMessaging.UpdateWhatsAppMessageTemplate",
  );
