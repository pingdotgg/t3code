import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link DeleteWhatsAppFlow}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface DeleteWhatsAppFlowRequest extends Omit<
  socialmessaging.DeleteWhatsAppFlowInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:DeleteWhatsAppFlow`.
 *
 * Deletes a DRAFT WhatsApp Flow from the bound account. Published flows
 * must be deprecated instead.
 *
 * The deploy-time half grants `social-messaging:DeleteWhatsAppFlow` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.DeleteWhatsAppFlowHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example Delete a Flow
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const deleteFlow = yield* AWS.SocialMessaging.DeleteWhatsAppFlow(account);
 *
 * // runtime
 * yield* deleteFlow({ flowId: "1234567890" });
 * ```
 */
export interface DeleteWhatsAppFlow extends Binding.Service<
  DeleteWhatsAppFlow,
  "AWS.SocialMessaging.DeleteWhatsAppFlow",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: DeleteWhatsAppFlowRequest,
    ) => Effect.Effect<
      socialmessaging.DeleteWhatsAppFlowOutput,
      socialmessaging.DeleteWhatsAppFlowError
    >
  >
> {}
export const DeleteWhatsAppFlow = Binding.Service<DeleteWhatsAppFlow>(
  "AWS.SocialMessaging.DeleteWhatsAppFlow",
);
