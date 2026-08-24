import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link ListWhatsAppTemplateLibrary}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface ListWhatsAppTemplateLibraryRequest extends Omit<
  socialmessaging.ListWhatsAppTemplateLibraryInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:ListWhatsAppTemplateLibrary`.
 *
 * Lists the pre-approved templates available in Meta's template library,
 * optionally filtered by category, topic, or industry.
 *
 * The deploy-time half grants `social-messaging:ListWhatsAppTemplateLibrary` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.ListWhatsAppTemplateLibraryHttp)`.
 * @binding
 * @section Managing Message Templates
 * @example Browse Meta's Template Library
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const browseLibrary = yield* AWS.SocialMessaging.ListWhatsAppTemplateLibrary(account);
 *
 * // runtime
 * const { metaLibraryTemplates } = yield* browseLibrary({
 *   filters: { category: "UTILITY" },
 * });
 * ```
 */
export interface ListWhatsAppTemplateLibrary extends Binding.Service<
  ListWhatsAppTemplateLibrary,
  "AWS.SocialMessaging.ListWhatsAppTemplateLibrary",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request?: ListWhatsAppTemplateLibraryRequest,
    ) => Effect.Effect<
      socialmessaging.ListWhatsAppTemplateLibraryOutput,
      socialmessaging.ListWhatsAppTemplateLibraryError
    >
  >
> {}
export const ListWhatsAppTemplateLibrary =
  Binding.Service<ListWhatsAppTemplateLibrary>(
    "AWS.SocialMessaging.ListWhatsAppTemplateLibrary",
  );
