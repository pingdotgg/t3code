import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link GetWhatsAppFlow}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface GetWhatsAppFlowRequest extends Omit<
  socialmessaging.GetWhatsAppFlowInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:GetWhatsAppFlow`.
 *
 * Retrieves a WhatsApp Flow's details — status, categories, validation
 * errors, health status — from the bound account.
 *
 * The deploy-time half grants `social-messaging:GetWhatsAppFlow` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.GetWhatsAppFlowHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example Read a Flow
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const getFlow = yield* AWS.SocialMessaging.GetWhatsAppFlow(account);
 *
 * // runtime
 * const flow = yield* getFlow({ flowId: "1234567890" });
 * const publishable = flow.validationErrors?.length === 0;
 * ```
 */
export interface GetWhatsAppFlow extends Binding.Service<
  GetWhatsAppFlow,
  "AWS.SocialMessaging.GetWhatsAppFlow",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: GetWhatsAppFlowRequest,
    ) => Effect.Effect<
      socialmessaging.GetWhatsAppFlowOutput,
      socialmessaging.GetWhatsAppFlowError
    >
  >
> {}
export const GetWhatsAppFlow = Binding.Service<GetWhatsAppFlow>(
  "AWS.SocialMessaging.GetWhatsAppFlow",
);
