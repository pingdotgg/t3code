import type * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `resource-groups:GetAccountSettings`.
 *
 * Reads the account's Resource Groups settings — most importantly whether
 * group lifecycle events (the EventBridge feed consumed by
 * {@link consumeGroupEvents}) are `ACTIVE`, `INACTIVE`, or stuck in
 * `ERROR`. Provide the implementation with
 * `Effect.provide(AWS.ResourceGroups.GetAccountSettingsHttp)`.
 * ### Account Settings
 * **Example:** Check Group Lifecycle Events Status
 * ```typescript
 * // init
 * const getAccountSettings = yield* AWS.ResourceGroups.GetAccountSettings();
 *
 * // runtime
 * const { AccountSettings } = yield* getAccountSettings();
 * const status = AccountSettings?.GroupLifecycleEventsStatus;
 * ```
 *
 * @binding
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
