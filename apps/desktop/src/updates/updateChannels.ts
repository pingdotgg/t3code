import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;
const PRODUCTION_BUNDLE_ID = "com.t3tools.t3code";

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}

export function resolveDesktopAppBundleId(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): string {
  if (input.isDevelopment) {
    return "com.t3tools.t3code.dev";
  }

  if (isNightlyDesktopVersion(input.appVersion)) {
    return "com.t3tools.t3code.nightly";
  }

  // Alpha-channel builds use a distinct bundle id so they can run alongside
  // Nightly and receive `t3://` deep links without single-instance conflicts.
  return "com.t3tools.t3code.alpha";
}

export function resolveDesktopBuildAppId(version: string): string {
  return resolveDesktopAppBundleId({ isDevelopment: false, appVersion: version });
}

export { PRODUCTION_BUNDLE_ID };
