import type { DesktopUpdateChannel } from "@t3tools/contracts";

// Preview builds are a temporary dogfooding train cut from nightly and share
// its branding and update channel.
const NIGHTLY_VERSION_PATTERN = /-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
