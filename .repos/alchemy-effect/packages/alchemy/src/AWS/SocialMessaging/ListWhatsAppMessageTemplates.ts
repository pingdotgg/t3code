import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link ListWhatsAppMessageTemplates}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface ListWhatsAppMessageTemplatesRequest extends Omit<
  socialmessaging.ListWhatsAppMessageTemplatesInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:ListWhatsAppMessageTemplates`.
 *
 * Lists the WhatsApp message templates of the bound account, with their
 * Meta review status and quality score.
 *
 * The deploy-time half grants `social-messaging:ListWhatsAppMessageTemplates` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.ListWhatsAppMessageTemplatesHttp)`.
 * @binding
 * @section Managing Message Templates
 * @example List Templates
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const listTemplates = yield* AWS.SocialMessaging.ListWhatsAppMessageTemplates(account);
 *
 * // runtime
 * const { templates } = yield* listTemplates({ maxResults: 25 });
 * ```
 */
export interface ListWhatsAppMessageTemplates extends Binding.Service<
  ListWhatsAppMessageTemplates,
  "AWS.SocialMessaging.ListWhatsAppMessageTemplates",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request?: ListWhatsAppMessageTemplatesRequest,
    ) => Effect.Effect<
      socialmessaging.ListWhatsAppMessageTemplatesOutput,
      socialmessaging.ListWhatsAppMessageTemplatesError
    >
  >
> {}
export const ListWhatsAppMessageTemplates =
  Binding.Service<ListWhatsAppMessageTemplates>(
    "AWS.SocialMessaging.ListWhatsAppMessageTemplates",
  );
