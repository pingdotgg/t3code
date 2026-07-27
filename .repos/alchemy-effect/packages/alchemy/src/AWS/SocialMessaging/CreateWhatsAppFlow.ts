import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link CreateWhatsAppFlow}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface CreateWhatsAppFlowRequest extends Omit<
  socialmessaging.CreateWhatsAppFlowInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:CreateWhatsAppFlow`.
 *
 * Creates a WhatsApp Flow (a rich interactive form users complete inside
 * WhatsApp) on the bound account, in DRAFT status unless `publish` is set
 * with a valid `flowJson`.
 *
 * The deploy-time half grants `social-messaging:CreateWhatsAppFlow` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.CreateWhatsAppFlowHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example Create a Flow
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const createFlow = yield* AWS.SocialMessaging.CreateWhatsAppFlow(account);
 *
 * // runtime
 * const { flowId, validationErrors } = yield* createFlow({
 *   flowName: "appointment-booking",
 *   categories: ["APPOINTMENT_BOOKING"],
 * });
 * ```
 */
export interface CreateWhatsAppFlow extends Binding.Service<
  CreateWhatsAppFlow,
  "AWS.SocialMessaging.CreateWhatsAppFlow",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: CreateWhatsAppFlowRequest,
    ) => Effect.Effect<
      socialmessaging.CreateWhatsAppFlowOutput,
      socialmessaging.CreateWhatsAppFlowError
    >
  >
> {}
export const CreateWhatsAppFlow = Binding.Service<CreateWhatsAppFlow>(
  "AWS.SocialMessaging.CreateWhatsAppFlow",
);
