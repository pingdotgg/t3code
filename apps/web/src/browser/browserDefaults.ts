/**
 * Browser defaults - resolves the configured starting state for preview tabs.
 *
 * Settings → Integrations → Browser lets the user pick the viewport, zoom, and
 * appearance a preview tab should open at. Those preferences apply to every
 * entry point that opens a tab without stating its own: the user opening a
 * browser panel, and agents calling `preview_open` with no size.
 *
 * The values live in client settings because the Chromium guest they configure
 * is desktop-local, so this module reads them through the same external store
 * the settings UI writes to, and exposes a non-hook accessor for the imperative
 * open paths that run outside React.
 *
 * @module browserDefaults
 */
import {
  DEFAULT_BROWSER_PROFILE_ID,
  findBrowserProfile,
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
    // A default pointing at a deleted profile falls back rather than opening
    // tabs into a partition with no profile behind it.
    profileId:
      findBrowserProfile(profiles, settings.browserDefaultProfileId)?.id ??
      DEFAULT_BROWSER_PROFILE_ID,
  };
};

/** Non-hook accessor for imperative open paths (menu actions, automation hosts). */
export function getBrowserDefaults(): BrowserDefaults {
  return toBrowserDefaults(getClientSettings());
}

/**
 * The defaults, once client settings have actually loaded.
 *
 * Opening a preview is asynchronous anyway, and before hydration the snapshot
 * is the schema defaults rather than the user's — a tab opened in that window
 * would be born at the wrong viewport, zoom and appearance and never corrected.
 */
export async function resolveBrowserDefaults(): Promise<BrowserDefaults> {
  await ensureClientSettingsHydrated();
  return getBrowserDefaults();
}

export function useBrowserDefaults(): BrowserDefaults {
  return useClientSettings(toBrowserDefaults);
}

/**
 * The zoom/appearance half of the defaults, in the shape `createTab` takes.
 * Passing these at creation rather than after registration keeps the guest from
 * painting a frame at 100%/system first.
 */
export function browserDefaultTabState(
  defaults: BrowserDefaults = getBrowserDefaults(),
): DesktopPreviewTabDefaults {
  return { zoomFactor: defaults.zoomFactor, colorScheme: defaults.appearance };
}

/**
 * The viewport a *newly opened* tab should start at. Sent with `preview.open`
 * so the session is born at the configured size instead of being resized a
 * frame later, which the user would see as a visible reflow.
 */
export function browserDefaultOpenViewport(
  defaults: BrowserDefaults = getBrowserDefaults(),
): PreviewViewportSetting {
  return defaults.viewport;
}

/** Profile a tab opens under when the caller doesn't name one. */
export function browserDefaultOpenProfileId(
  defaults: BrowserDefaults = getBrowserDefaults(),
): string {
  return defaults.profileId;
}

/**
 * The viewport to switch to when the user turns the device toolbar on for a tab
 * currently in fill mode.
 *
 * A configured non-fill default is what the user said they want to look at, so
 * it wins. When the default is fill there is no stated preference to honour, so
 * fall back to fitting the panel — and only when the panel hasn't been measured
 * yet does a fixed size apply.
 */
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
