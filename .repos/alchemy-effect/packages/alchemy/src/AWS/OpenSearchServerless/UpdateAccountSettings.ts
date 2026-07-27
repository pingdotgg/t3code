import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `UpdateAccountSettings` operation (IAM action
 * `aoss:UpdateAccountSettings`; the action does not support resource-level
 * scoping, so the grant is on `*`).
 *
 * Updates the account-level OCU capacity limits — the cost-control automation
 * path (e.g. a budget alarm handler capping search capacity). Provide the
 * implementation with
 * `Effect.provide(AWS.OpenSearchServerless.UpdateAccountSettingsHttp)`.
 * @binding
 * @section Account Settings
 * @example Cap the account's search capacity
 * ```typescript
 * const updateAccountSettings = yield* AWS.OpenSearchServerless.UpdateAccountSettings();
 *
 * yield* updateAccountSettings({
 *   capacityLimits: { maxSearchCapacityInOCU: 4 },
 * });
 * ```
 */
export interface UpdateAccountSettings extends Binding.Service<
  UpdateAccountSettings,
  "AWS.OpenSearchServerless.UpdateAccountSettings",
  () => Effect.Effect<
    (
      request: aoss.UpdateAccountSettingsRequest,
    ) => Effect.Effect<
      aoss.UpdateAccountSettingsResponse,
      aoss.UpdateAccountSettingsError
    >
  >
> {}
export const UpdateAccountSettings = Binding.Service<UpdateAccountSettings>(
  "AWS.OpenSearchServerless.UpdateAccountSettings",
);
