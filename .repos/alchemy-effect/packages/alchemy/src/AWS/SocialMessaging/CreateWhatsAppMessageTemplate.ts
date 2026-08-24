import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link CreateWhatsAppMessageTemplate}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface CreateWhatsAppMessageTemplateRequest extends Omit<
  socialmessaging.CreateWhatsAppMessageTemplateInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:CreateWhatsAppMessageTemplate`.
 *
 * Creates a WhatsApp message template on the bound account from a raw Meta
 * template-definition JSON blob. Templates must be approved by Meta before
 * they can be sent.
 *
 * The deploy-time half grants `social-messaging:CreateWhatsAppMessageTemplate` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.CreateWhatsAppMessageTemplateHttp)`.
 * @binding
 * @section Managing Message Templates
 * @example Create a Template from a Definition
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const createTemplate = yield* AWS.SocialMessaging.CreateWhatsAppMessageTemplate(account);
 *
 * // runtime
 * const { metaTemplateId, templateStatus } = yield* createTemplate({
 *   templateDefinition: new TextEncoder().encode(
 *     JSON.stringify({
 *       name: "order_update",
 *       language: "en_US",
 *       category: "UTILITY",
 *       components: [{ type: "BODY", text: "Your order {{1}} shipped." }],
 *     }),
 *   ),
 * });
 * ```
 */
export interface CreateWhatsAppMessageTemplate extends Binding.Service<
  CreateWhatsAppMessageTemplate,
  "AWS.SocialMessaging.CreateWhatsAppMessageTemplate",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: CreateWhatsAppMessageTemplateRequest,
    ) => Effect.Effect<
      socialmessaging.CreateWhatsAppMessageTemplateOutput,
      socialmessaging.CreateWhatsAppMessageTemplateError
    >
  >
> {}
export const CreateWhatsAppMessageTemplate =
  Binding.Service<CreateWhatsAppMessageTemplate>(
    "AWS.SocialMessaging.CreateWhatsAppMessageTemplate",
  );
