import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link PublishWhatsAppFlow}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface PublishWhatsAppFlowRequest extends Omit<
  socialmessaging.PublishWhatsAppFlowInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:PublishWhatsAppFlow`.
 *
 * Publishes a DRAFT WhatsApp Flow on the bound account so it can be sent to
 * users. Published flows can no longer be edited, only deprecated.
 *
 * The deploy-time half grants `social-messaging:PublishWhatsAppFlow` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.PublishWhatsAppFlowHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example Publish a Flow
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const publishFlow = yield* AWS.SocialMessaging.PublishWhatsAppFlow(account);
 *
 * // runtime
 * yield* publishFlow({ flowId: "1234567890" });
 * ```
 */
export interface PublishWhatsAppFlow extends Binding.Service<
  PublishWhatsAppFlow,
  "AWS.SocialMessaging.PublishWhatsAppFlow",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: PublishWhatsAppFlowRequest,
    ) => Effect.Effect<
      socialmessaging.PublishWhatsAppFlowOutput,
      socialmessaging.PublishWhatsAppFlowError
    >
  >
> {}
export const PublishWhatsAppFlow = Binding.Service<PublishWhatsAppFlow>(
  "AWS.SocialMessaging.PublishWhatsAppFlow",
);
