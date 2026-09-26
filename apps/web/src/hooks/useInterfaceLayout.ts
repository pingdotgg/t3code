import type { PresetSettings } from "../components/customize/customizePresets";
import { resolvePresetPreview } from "../components/customize/customizePresets";
import { useCustomizeInterfaceStore } from "../components/customize/customizeInterfaceStore";
import { useMemo } from "react";

import {
  type InterfaceSurfaceId,
  type ResolvedSurfaceLayout,
  resolveSurfaceLayout,
} from "../interfaceLayout";
import { useClientSetting } from "./useSettings";

/** The user's arrangement of one surface, resolved against its current elements. */
export function useInterfaceLayout<S extends InterfaceSurfaceId>(
  surface: S,
): ResolvedSurfaceLayout<S> {
  const layout = usePreviewedLayoutSetting("interfaceLayout");
  return useMemo(() => resolveSurfaceLayout(surface, layout), [layout, surface]);
}

/** Rendering-only overrides; settings editors and snapshots still read saved values. */
export function usePreviewedLayoutSetting<K extends keyof PresetSettings>(
  key: K,
): PresetSettings[K] {
  const current = useClientSetting(key);
  const previewId = useCustomizeInterfaceStore((store) =>
    store.active ? store.previewPresetId : null,
  );
  return resolvePresetPreview(key, current, true, previewId);
}
