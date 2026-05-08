import type { DesktopAppBranding } from "@forma/contracts";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();

export type BuildDefaultAppIconId = "forma-prod" | "forma-nightly" | "forma-dev";

export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "Forma";
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ?? (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ?? `${APP_BASE_NAME} (${APP_STAGE_LABEL})`;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";

export function resolveDefaultBuildAppIconId(
  stageLabel: string = APP_STAGE_LABEL,
): BuildDefaultAppIconId {
  if (stageLabel === "Dev") {
    return "forma-dev";
  }
  if (stageLabel === "Nightly") {
    return "forma-nightly";
  }
  return "forma-prod";
}

export const APP_DEFAULT_ICON_ID = resolveDefaultBuildAppIconId();
