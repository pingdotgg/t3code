import type { DesktopAppBranding, DesktopAppStageLabel } from "@t3tools/contracts";

const APP_BASE_NAME = "T3 Code";
const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

export function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }

  return NIGHTLY_VERSION_PATTERN.test(input.appVersion) ? "Nightly" : "Alpha";
}

export function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}
