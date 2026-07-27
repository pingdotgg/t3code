import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link GetWhatsAppFlowPreview}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface GetWhatsAppFlowPreviewRequest extends Omit<
  socialmessaging.GetWhatsAppFlowPreviewInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:GetWhatsAppFlowPreview`.
 *
 * Generates (or refreshes with `invalidate`) a shareable preview URL for a
 * WhatsApp Flow on the bound account.
 *
 * The deploy-time half grants `social-messaging:GetWhatsAppFlowPreview` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.GetWhatsAppFlowPreviewHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example Get a Flow Preview URL
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const getFlowPreview = yield* AWS.SocialMessaging.GetWhatsAppFlowPreview(account);
 *
 * // runtime
 * const { preview } = yield* getFlowPreview({
 *   flowId: "1234567890",
 *   invalidate: true,
 * });
 * ```
 */
export interface GetWhatsAppFlowPreview extends Binding.Service<
  GetWhatsAppFlowPreview,
  "AWS.SocialMessaging.GetWhatsAppFlowPreview",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: GetWhatsAppFlowPreviewRequest,
    ) => Effect.Effect<
      socialmessaging.GetWhatsAppFlowPreviewOutput,
      socialmessaging.GetWhatsAppFlowPreviewError
    >
  >
> {}
export const GetWhatsAppFlowPreview = Binding.Service<GetWhatsAppFlowPreview>(
  "AWS.SocialMessaging.GetWhatsAppFlowPreview",
);
