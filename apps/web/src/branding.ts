import type { DesktopAppBranding } from "@t3tools/contracts";
import {
  formatAppDisplayName,
  resolveHostedAppChannelLabel,
  resolveWebAppStageLabel,
} from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const desktopBuildBrand = import.meta.env.VITE_DESKTOP_BUILD_BRAND?.trim().toLowerCase();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL = resolveHostedAppChannelLabel(HOSTED_APP_CHANNEL);
export const APP_BASE_NAME =
  injectedDesktopAppBranding?.baseName ?? (desktopBuildBrand === "dulli" ? "T3 Dulli" : "T3 Code");
// Text displayed beside the shared T3 wordmark.
export const APP_WORDMARK_LABEL = APP_BASE_NAME.replace(/^T3 /, "");
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  resolveWebAppStageLabel({
    hostedAppChannel: HOSTED_APP_CHANNEL,
    development: import.meta.env.DEV,
    dulli: desktopBuildBrand === "dulli",
  });
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
export const DESKTOP_DOWNLOAD_URL =
  APP_BASE_NAME === "T3 Dulli"
    ? "https://github.com/YJJosh/t3dulli/releases"
    : "https://t3.codes/download";
// Redirects to the App Store or Google Play to match the phone that opens it.
export const MOBILE_APP_URL =
  APP_BASE_NAME === "T3 Dulli"
    ? "https://github.com/YJJosh/t3dulli/releases"
    : "https://t3.codes/mobile";
