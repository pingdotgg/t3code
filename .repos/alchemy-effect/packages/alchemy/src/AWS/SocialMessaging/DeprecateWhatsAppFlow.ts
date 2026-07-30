import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link DeprecateWhatsAppFlow}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface DeprecateWhatsAppFlowRequest extends Omit<
  socialmessaging.DeprecateWhatsAppFlowInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:DeprecateWhatsAppFlow`.
 *
 * Deprecates a published WhatsApp Flow on the bound account so it can no
 * longer be sent to users.
 *
 * The deploy-time half grants `social-messaging:DeprecateWhatsAppFlow` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.DeprecateWhatsAppFlowHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example Deprecate a Flow
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const deprecateFlow = yield* AWS.SocialMessaging.DeprecateWhatsAppFlow(account);
 *
 * // runtime
 * yield* deprecateFlow({ flowId: "1234567890" });
 * ```
 */
export interface DeprecateWhatsAppFlow extends Binding.Service<
  DeprecateWhatsAppFlow,
  "AWS.SocialMessaging.DeprecateWhatsAppFlow",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: DeprecateWhatsAppFlowRequest,
    ) => Effect.Effect<
      socialmessaging.DeprecateWhatsAppFlowOutput,
      socialmessaging.DeprecateWhatsAppFlowError
    >
  >
> {}
export const DeprecateWhatsAppFlow = Binding.Service<DeprecateWhatsAppFlow>(
  "AWS.SocialMessaging.DeprecateWhatsAppFlow",
);
