import { msg } from "gt-i18n";

export const MAC_PERMISSION_SETTINGS_URLS = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
};

export type MacPermission = keyof typeof MAC_PERMISSION_SETTINGS_URLS;

export const MAC_PERMISSION_SETUP_TITLES: Record<MacPermission, string> = {
  "screen-recording": msg("Set up Screen Recording"),
  accessibility: msg("Set up Accessibility"),
  "full-disk-access": msg("Set up Full Disk Access"),
};
