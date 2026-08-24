import type * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `lambda:GetAccountSettings`.
 *
 * An account-level binding — call it with no arguments to get a callable
 * that reads the region's Lambda quotas (`AccountLimit`) and current usage
 * (`AccountUsage`). Provide the `GetAccountSettingsHttp` layer on the
 * Function to satisfy the binding.
 * @binding
 * @section Account Settings
 * @example Read account limits and usage
 * ```typescript
 * const getAccountSettings = yield* AWS.Lambda.GetAccountSettings();
 *
 * const settings = yield* getAccountSettings();
 * const concurrency = settings.AccountLimit?.ConcurrentExecutions;
 * ```
 */
export interface GetAccountSettings extends Binding.Service<
  GetAccountSettings,
  "AWS.Lambda.GetAccountSettings",
  () => Effect.Effect<
    () => Effect.Effect<
      Lambda.GetAccountSettingsResponse,
      Lambda.GetAccountSettingsError
    >
  >
> {}
export const GetAccountSettings = Binding.Service<GetAccountSettings>(
  "AWS.Lambda.GetAccountSettings",
);
