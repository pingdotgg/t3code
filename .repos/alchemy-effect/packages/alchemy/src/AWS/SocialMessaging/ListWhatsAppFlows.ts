import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link ListWhatsAppFlows}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface ListWhatsAppFlowsRequest extends Omit<
  socialmessaging.ListWhatsAppFlowsInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:ListWhatsAppFlows`.
 *
 * Lists the WhatsApp Flows of the bound account with their status and
 * validation errors.
 *
 * The deploy-time half grants `social-messaging:ListWhatsAppFlows` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.ListWhatsAppFlowsHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example List Flows
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const listFlows = yield* AWS.SocialMessaging.ListWhatsAppFlows(account);
 *
 * // runtime
 * const { flows } = yield* listFlows({ maxResults: 25 });
 * ```
 */
export interface ListWhatsAppFlows extends Binding.Service<
  ListWhatsAppFlows,
  "AWS.SocialMessaging.ListWhatsAppFlows",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request?: ListWhatsAppFlowsRequest,
    ) => Effect.Effect<
      socialmessaging.ListWhatsAppFlowsOutput,
      socialmessaging.ListWhatsAppFlowsError
    >
  >
> {}
export const ListWhatsAppFlows = Binding.Service<ListWhatsAppFlows>(
  "AWS.SocialMessaging.ListWhatsAppFlows",
);
