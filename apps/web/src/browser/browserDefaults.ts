import {
  DEFAULT_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
  type DesktopPreviewTabDefaults,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
} from "@t3tools/contracts";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  useClientSettings,
} from "~/hooks/useSettings";

import { resolveResponsiveBrowserViewportSize } from "./browserViewportLayout";

export interface BrowserDefaults {
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly appearance: PreviewAppearancePreference;
  readonly autoShowFloatingPreview: boolean;
  readonly profiles: ReadonlyArray<BrowserProfile>;
  readonly profileId: string;
}

const toBrowserDefaults = (settings: {
  readonly browserDefaultViewport: PreviewViewportSetting;
  readonly browserDefaultZoomFactor: number;
  readonly browserDefaultAppearance: PreviewAppearancePreference;
  readonly browserAutoShowFloatingPreview: boolean;
  readonly browserProfiles: ReadonlyArray<BrowserProfile>;
  readonly browserDefaultProfileId: string;
}): BrowserDefaults => {
  const profiles = resolveBrowserProfiles(settings.browserProfiles);
  return {
    viewport: settings.browserDefaultViewport,
    zoomFactor: settings.browserDefaultZoomFactor,
    appearance: settings.browserDefaultAppearance,
    autoShowFloatingPreview: settings.browserAutoShowFloatingPreview,
    profiles,
    profileId:
      profiles.find(
        (profile) =>
          profile.id === settings.browserDefaultProfileId && profile.kind !== "incognito",
      )?.id ?? DEFAULT_BROWSER_PROFILE_ID,
  };
};

export function getBrowserDefaults(): BrowserDefaults {
  return toBrowserDefaults(getClientSettings());
}

/** New tabs retain their initial defaults, so wait for settings hydration. Read failures reject. */
export async function resolveBrowserDefaults(): Promise<BrowserDefaults> {
  await ensureClientSettingsHydrated();
  return getBrowserDefaults();
}

export function useBrowserDefaults(): BrowserDefaults {
  return useClientSettings(toBrowserDefaults);
}

export function browserDefaultTabState(
  defaults: BrowserDefaults = getBrowserDefaults(),
): DesktopPreviewTabDefaults {
  return { zoomFactor: defaults.zoomFactor, colorScheme: defaults.appearance };
}

export function browserDefaultOpenViewport(
  defaults: BrowserDefaults = getBrowserDefaults(),
): PreviewViewportSetting {
  return defaults.viewport;
}

export function browserDefaultOpenProfileId(
  defaults: BrowserDefaults = getBrowserDefaults(),
): string {
  return defaults.profileId;
}

export const FALLBACK_RESPONSIVE_VIEWPORT_SIZE = { width: 1024, height: 768 } as const;

export function browserResponsiveViewportForToggle(input: {
  readonly defaults?: BrowserDefaults;
  readonly panelRect: { readonly width: number; readonly height: number } | null;
  readonly zoomFactor: number | undefined;
}): PreviewViewportSetting {
  const defaults = input.defaults ?? getBrowserDefaults();
  if (defaults.viewport._tag !== "fill") return defaults.viewport;
  const size = input.panelRect
    ? resolveResponsiveBrowserViewportSize(input.panelRect, input.zoomFactor)
    : FALLBACK_RESPONSIVE_VIEWPORT_SIZE;
  return { _tag: "freeform", ...size };
}
