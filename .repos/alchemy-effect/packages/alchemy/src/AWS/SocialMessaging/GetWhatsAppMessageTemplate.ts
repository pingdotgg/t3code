import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link GetWhatsAppMessageTemplate}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface GetWhatsAppMessageTemplateRequest extends Omit<
  socialmessaging.GetWhatsAppMessageTemplateInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:GetWhatsAppMessageTemplate`.
 *
 * Retrieves a WhatsApp message template's JSON definition from the bound
 * account by its Meta template id.
 *
 * The deploy-time half grants `social-messaging:GetWhatsAppMessageTemplate` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.GetWhatsAppMessageTemplateHttp)`.
 * @binding
 * @section Managing Message Templates
 * @example Read a Template
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const getTemplate = yield* AWS.SocialMessaging.GetWhatsAppMessageTemplate(account);
 *
 * // runtime
 * const { template } = yield* getTemplate({
 *   metaTemplateId: "1234567890",
 * });
 * ```
 */
export interface GetWhatsAppMessageTemplate extends Binding.Service<
  GetWhatsAppMessageTemplate,
  "AWS.SocialMessaging.GetWhatsAppMessageTemplate",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: GetWhatsAppMessageTemplateRequest,
    ) => Effect.Effect<
      socialmessaging.GetWhatsAppMessageTemplateOutput,
      socialmessaging.GetWhatsAppMessageTemplateError
    >
  >
> {}
export const GetWhatsAppMessageTemplate =
  Binding.Service<GetWhatsAppMessageTemplate>(
    "AWS.SocialMessaging.GetWhatsAppMessageTemplate",
  );
