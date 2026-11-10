import type * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `servicequotas:GetAutoManagementConfiguration` — read
 * the account's Service Quotas Auto Management opt-in status (opt-in type,
 * notification target, excluded quotas) from inside a Function.
 *
 * ### Auto Management
 * **Example:** Check the Auto Management opt-in status
 * ```typescript
 * // init
 * const getAutoManagementConfiguration =
 *   yield* AWS.ServiceQuotas.GetAutoManagementConfiguration();
 *
 * // runtime — fails with the typed NoSuchResourceException when the
 * // account has not opted in to Auto Management
 * const config = yield* getAutoManagementConfiguration();
 * const optIn = config.OptInType; // NotifyOnly | NotifyAndAdjust
 * ```
 *
 * @binding
 */
export interface GetAutoManagementConfiguration extends Binding.Service<
  GetAutoManagementConfiguration,
  "AWS.ServiceQuotas.GetAutoManagementConfiguration",
  () => Effect.Effect<
    (
      request?: servicequotas.GetAutoManagementConfigurationRequest,
    ) => Effect.Effect<
      servicequotas.GetAutoManagementConfigurationResponse,
      servicequotas.GetAutoManagementConfigurationError
    >
  >
> {}
export const GetAutoManagementConfiguration = Binding.Service<GetAutoManagementConfiguration>(
  "AWS.ServiceQuotas.GetAutoManagementConfiguration",
);
