// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type {
  EyeballRouterConfig,
  RouterConfig,
} from "../../../shared/types.ts";

type RequiredEyeballRouterConfig = Required<Exclude<EyeballRouterConfig, null>>;

export const applyRouterConfigDefaults = (
  configuration?: RouterConfig,
): Required<RouterConfig> => {
  return {
    invoke_user_worker_ahead_of_assets:
      configuration?.invoke_user_worker_ahead_of_assets ?? false,
    has_user_worker: configuration?.has_user_worker ?? false,
    account_id: configuration?.account_id ?? -1,
    script_id: configuration?.script_id ?? -1,
    debug: configuration?.debug ?? false,
    static_routing: configuration?.static_routing ?? {
      user_worker: [],
    },
  };
};

export const applyEyeballConfigDefaults = (
  eyeballConfiguration?: EyeballRouterConfig,
): RequiredEyeballRouterConfig => {
  return {
    limitedAssetsOnly: eyeballConfiguration?.limitedAssetsOnly ?? false,
  };
};
