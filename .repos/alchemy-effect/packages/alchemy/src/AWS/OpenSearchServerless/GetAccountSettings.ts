import type * as aoss from "@distilled.cloud/aws/opensearchserverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `GetAccountSettings` operation (IAM action
 * `aoss:GetAccountSettings`; the action does not support resource-level
 * scoping, so the grant is on `*`).
 *
 * Reads the account-level OpenSearch Serverless settings — the OCU capacity
 * limits that cap the account's spend. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.GetAccountSettingsHttp)`.
 * @binding
 * @section Account Settings
 * @example Read the account's OCU capacity limits
 * ```typescript
 * const getAccountSettings = yield* AWS.OpenSearchServerless.GetAccountSettings();
 *
 * const settings = yield* getAccountSettings();
 * const limits = settings.accountSettingsDetail?.capacityLimits;
 * yield* Effect.log(`max indexing OCUs: ${limits?.maxIndexingCapacityInOCU}`);
 * ```
 */
export interface GetAccountSettings extends Binding.Service<
  GetAccountSettings,
  "AWS.OpenSearchServerless.GetAccountSettings",
  () => Effect.Effect<
    (
      request?: aoss.GetAccountSettingsRequest,
    ) => Effect.Effect<
      aoss.GetAccountSettingsResponse,
      aoss.GetAccountSettingsError
    >
  >
> {}
export const GetAccountSettings = Binding.Service<GetAccountSettings>(
  "AWS.OpenSearchServerless.GetAccountSettings",
);
