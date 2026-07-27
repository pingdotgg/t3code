import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link ListWhatsAppFlowAssets}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface ListWhatsAppFlowAssetsRequest extends Omit<
  socialmessaging.ListWhatsAppFlowAssetsInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:ListWhatsAppFlowAssets`.
 *
 * Lists the assets (Flow JSON) of a WhatsApp Flow on the bound account,
 * with download URLs.
 *
 * The deploy-time half grants `social-messaging:ListWhatsAppFlowAssets` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.ListWhatsAppFlowAssetsHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example List a Flow's Assets
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const listFlowAssets = yield* AWS.SocialMessaging.ListWhatsAppFlowAssets(account);
 *
 * // runtime
 * const { flowAssets } = yield* listFlowAssets({
 *   flowId: "1234567890",
 * });
 * ```
 */
export interface ListWhatsAppFlowAssets extends Binding.Service<
  ListWhatsAppFlowAssets,
  "AWS.SocialMessaging.ListWhatsAppFlowAssets",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: ListWhatsAppFlowAssetsRequest,
    ) => Effect.Effect<
      socialmessaging.ListWhatsAppFlowAssetsOutput,
      socialmessaging.ListWhatsAppFlowAssetsError
    >
  >
> {}
export const ListWhatsAppFlowAssets = Binding.Service<ListWhatsAppFlowAssets>(
  "AWS.SocialMessaging.ListWhatsAppFlowAssets",
);
