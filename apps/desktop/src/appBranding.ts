import type { DesktopAppBranding, DesktopAppStageLabel } from "@t3tools/contracts";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

const APP_BASE_NAME = "T3 Code";
const LOCAL_ALPHA_PRODUCT_NAME = "T3 Code (Local Alpha)";

export function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  readonly packageProductName?: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }

  if (input.packageProductName === "T3 Code (Dev)") {
    return "Dev";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

export function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  readonly packageProductName?: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName:
      stageLabel === "Alpha" && input.packageProductName === LOCAL_ALPHA_PRODUCT_NAME
        ? LOCAL_ALPHA_PRODUCT_NAME
        : `${APP_BASE_NAME} (${stageLabel})`,
  };
}
