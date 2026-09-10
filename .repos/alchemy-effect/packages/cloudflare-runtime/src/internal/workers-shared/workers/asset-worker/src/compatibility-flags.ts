// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type { AssetConfig } from "../../../shared/types.ts";

interface CompatibilityFlag {
  enable: `assets_${string}`;
  disable: `assets_${string}`;
  onByDefaultAfter?: string;
}

export const SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING = {
  enable: "assets_navigation_prefers_asset_serving",
  disable: "assets_navigation_has_no_effect",
  onByDefaultAfter: "2025-04-01",
} satisfies CompatibilityFlag;

const COMPATIBILITY_FLAGS = [
  SEC_FETCH_MODE_NAVIGATE_HEADER_PREFERS_ASSET_SERVING,
] as const;

export type ENABLEMENT_COMPATIBILITY_FLAGS =
  (typeof COMPATIBILITY_FLAGS)[number]["enable"];

export const resolveCompatibilityOptions = (configuration?: AssetConfig) => {
  const compatibilityDate = configuration?.compatibility_date ?? "2021-11-02";
  const compatibilityFlags = configuration?.compatibility_flags ?? [];

  const resolvedCompatibilityFlags = compatibilityFlags;
  for (const compatibilityFlag of COMPATIBILITY_FLAGS) {
    if (
      compatibilityFlag.onByDefaultAfter &&
      compatibilityDate >= compatibilityFlag.onByDefaultAfter &&
      !resolvedCompatibilityFlags.find(
        (flag) => flag === compatibilityFlag.disable,
      ) &&
      !resolvedCompatibilityFlags.find(
        (flag) => flag === compatibilityFlag.enable,
      )
    ) {
      resolvedCompatibilityFlags.push(compatibilityFlag.enable);
    }
  }

  return {
    compatibilityDate,
    compatibilityFlags: resolvedCompatibilityFlags,
  };
};

export const flagIsEnabled = (
  configuration: Required<AssetConfig>,
  compatibilityFlag: (typeof COMPATIBILITY_FLAGS)[number],
) => {
  return !!configuration.compatibility_flags.find(
    (flag) => flag === compatibilityFlag.enable,
  );
};
