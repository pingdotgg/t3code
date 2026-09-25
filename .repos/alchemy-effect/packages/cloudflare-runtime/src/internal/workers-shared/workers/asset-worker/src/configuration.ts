// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { resolveCompatibilityOptions } from "./compatibility-flags.ts";
import type { AssetConfig } from "../../../shared/types.ts";

export const normalizeConfiguration = (
  configuration?: AssetConfig,
): Required<AssetConfig> => {
  const compatibilityOptions = resolveCompatibilityOptions(configuration);

  return {
    compatibility_date: compatibilityOptions.compatibilityDate,
    compatibility_flags: compatibilityOptions.compatibilityFlags,
    html_handling: configuration?.html_handling ?? "auto-trailing-slash",
    not_found_handling: configuration?.not_found_handling ?? "none",
    redirects: configuration?.redirects ?? {
      version: 1,
      staticRules: {},
      rules: {},
    },
    headers: configuration?.headers ?? {
      version: 2,
      rules: {},
    },
    has_static_routing: configuration?.has_static_routing ?? false,
    account_id: configuration?.account_id ?? -1,
    script_id: configuration?.script_id ?? -1,
    debug: configuration?.debug ?? false,
  };
};
