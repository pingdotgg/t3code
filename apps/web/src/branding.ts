import type { DesktopAppBranding } from "@t3tools/contracts";
import { formatAppDisplayName, formatDisplayedAppVersion } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
export const APP_BASE_NAME =
  injectedDesktopAppBranding?.baseName ?? import.meta.env.VITE_APP_BASE_NAME?.trim() ?? "MT Code";
export const APP_HAS_UPDATE_TRACKS = APP_BASE_NAME !== "MT Code";

const resolvedStageLabel =
  injectedDesktopAppBranding?.stageLabel ??
  import.meta.env.VITE_APP_STAGE_LABEL?.trim() ??
  (APP_HAS_UPDATE_TRACKS ? HOSTED_APP_CHANNEL_LABEL : null) ??
  (import.meta.env.DEV ? "Dev" : "Beta");

export const APP_STAGE_LABEL =
  !APP_HAS_UPDATE_TRACKS && resolvedStageLabel === "Nightly"
    ? import.meta.env.DEV
      ? "Dev"
      : "Beta"
    : resolvedStageLabel;
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  import.meta.env.VITE_APP_DISPLAY_NAME?.trim() ??
  (APP_HAS_UPDATE_TRACKS
    ? formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL })
    : APP_BASE_NAME);
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
export const APP_DISPLAY_VERSION = formatDisplayedAppVersion({
  version: APP_VERSION,
  stripNightlyPrerelease: !APP_HAS_UPDATE_TRACKS,
});
export const APP_GITHUB_REPOSITORY = "munimtechnologies/mtcode";
export const DESKTOP_DOWNLOAD_URL = `https://github.com/${APP_GITHUB_REPOSITORY}/releases/latest`;
// Redirects to the App Store or Google Play to match the phone that opens it.
export const MOBILE_APP_URL = "https://t3.codes/mobile";
