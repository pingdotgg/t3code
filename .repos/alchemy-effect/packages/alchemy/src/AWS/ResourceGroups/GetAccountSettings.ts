import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `resource-groups:GetAccountSettings`.
 *
 * Reads the account's Resource Groups settings — most importantly whether
 * group lifecycle events (the EventBridge feed consumed by
 * {@link consumeGroupEvents}) are `ACTIVE`, `INACTIVE`, or stuck in
 * `ERROR`. Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.GetAccountSettingsHttp)`.
 * @binding
 * @section Account Settings
 * @example Check Group Lifecycle Events Status
 * ```typescript
 * // init
 * const getAccountSettings = yield* AWS.ResourceGroups.GetAccountSettings();
 *
 * // runtime
 * const { AccountSettings } = yield* getAccountSettings();
 * const status = AccountSettings?.GroupLifecycleEventsStatus;
 * ```
 */
export interface GetAccountSettings extends Binding.Service<
  GetAccountSettings,
  "AWS.ResourceGroups.GetAccountSettings",
  () => Effect.Effect<
    () => Effect.Effect<
      resourcegroups.GetAccountSettingsOutput,
      resourcegroups.GetAccountSettingsError
    >
  >
> {}
export const GetAccountSettings = Binding.Service<GetAccountSettings>(
  "AWS.ResourceGroups.GetAccountSettings",
);
