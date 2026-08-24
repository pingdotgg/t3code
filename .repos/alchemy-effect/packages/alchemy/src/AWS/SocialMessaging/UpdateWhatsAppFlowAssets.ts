import type * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Request for {@link UpdateWhatsAppFlowAssets}. The linked WABA `id` is injected by
 * the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
 */
export interface UpdateWhatsAppFlowAssetsRequest extends Omit<
  socialmessaging.UpdateWhatsAppFlowAssetsInput,
  "id"
> {}

/**
 * Runtime binding for `social-messaging:UpdateWhatsAppFlowAssets`.
 *
 * Replaces a WhatsApp Flow's Flow JSON asset on the bound account and
 * returns any validation errors Meta reports.
 *
 * The deploy-time half grants `social-messaging:UpdateWhatsAppFlowAssets` on the
 * bound WABA's ARN and the runtime half injects the linked account id
 * into every request.
 * Provide the implementation with
 * `Effect.provide(AWS.SocialMessaging.UpdateWhatsAppFlowAssetsHttp)`.
 * @binding
 * @section Managing WhatsApp Flows
 * @example Upload Flow JSON
 * ```typescript
 * // init — bind the operation to the linked WABA
 * const updateFlowAssets = yield* AWS.SocialMessaging.UpdateWhatsAppFlowAssets(account);
 *
 * // runtime
 * const { validationErrors } = yield* updateFlowAssets({
 *   flowId: "1234567890",
 *   flowJson: new TextEncoder().encode(JSON.stringify(flowDefinition)),
 * });
 * ```
 */
export interface UpdateWhatsAppFlowAssets extends Binding.Service<
  UpdateWhatsAppFlowAssets,
  "AWS.SocialMessaging.UpdateWhatsAppFlowAssets",
  (
    account: LinkedWhatsAppBusinessAccount,
  ) => Effect.Effect<
    (
      request: UpdateWhatsAppFlowAssetsRequest,
    ) => Effect.Effect<
      socialmessaging.UpdateWhatsAppFlowAssetsOutput,
      socialmessaging.UpdateWhatsAppFlowAssetsError
    >
  >
> {}
export const UpdateWhatsAppFlowAssets =
  Binding.Service<UpdateWhatsAppFlowAssets>(
    "AWS.SocialMessaging.UpdateWhatsAppFlowAssets",
  );
