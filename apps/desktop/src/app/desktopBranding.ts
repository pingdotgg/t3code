import type { DesktopAppBranding } from "@t3tools/contracts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

const APP_BASE_NAME = "T3 Code";

export function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = input.isDevelopment
    ? "Dev"
    : isNightlyDesktopVersion(input.appVersion)
      ? "Nightly"
      : "Beta";
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}
