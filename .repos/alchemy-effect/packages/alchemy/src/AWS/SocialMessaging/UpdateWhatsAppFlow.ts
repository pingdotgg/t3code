import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link UpdateWhatsAppFlow}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface UpdateWhatsAppFlowRequest extends Omit<
  socialmessaging.UpdateWhatsAppFlowInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:UpdateWhatsAppFlow`.
 *
 * Updates a WhatsApp Flow's name and categories on the bound account.
 *
 * The deploy-time half grants `social-messaging:UpdateWhatsAppFlow` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.UpdateWhatsAppFlowHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example Rename a Flow
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const updateFlow = yield* AWS.SocialMessaging.UpdateWhatsAppFlow(account);
 *
 * // runtime
 * yield* updateFlow({
 *   flowId: "1234567890",
 *   flowName: "appointment-booking-v2",
 * });
 * ```
 */
export interface UpdateWhatsAppFlow extends Binding.Service<
  UpdateWhatsAppFlow,
  "AWS.SocialMessaging.UpdateWhatsAppFlow",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: UpdateWhatsAppFlowRequest,
    ) => Effect.Effect<
      socialmessaging.UpdateWhatsAppFlowOutput,
      socialmessaging.UpdateWhatsAppFlowError
    >
  >
> {}
export const UpdateWhatsAppFlow = Binding.Service<UpdateWhatsAppFlow>(
  "AWS.SocialMessaging.UpdateWhatsAppFlow",
);
