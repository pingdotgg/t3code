import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

export interface DesktopUpdateButtonSummary {
  label: string;
  detail: string;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "downloaded") {
    return "install";
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return "install";
    }
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowDesktopUpdateStatus(state: DesktopUpdateState | null): boolean {
  return state?.enabled === true;
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getDesktopUpdateButtonSummary(
  state: DesktopUpdateState,
): DesktopUpdateButtonSummary {
  if (state.status === "available") {
    return {
      label: "Update available",
      detail: `Version ${state.availableVersion ?? "available"} is ready to download.`,
    };
  }
  if (state.status === "checking") {
    return {
      label: "Checking for updates",
      detail: `Current version ${state.currentVersion}`,
    };
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? `${Math.floor(state.downloadPercent)}% complete` : "In progress";
    return {
      label: "Downloading update",
      detail: progress,
    };
  }
  if (state.status === "downloaded") {
    return {
      label: "Ready to install",
      detail: `Restart into ${state.downloadedVersion ?? state.availableVersion ?? "the new version"}.`,
    };
  }
  if (state.status === "up-to-date") {
    return {
      label: "Up to date",
      detail: `Version ${state.currentVersion} is installed.`,
    };
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return {
        label: "Update download failed",
        detail: state.message?.trim() || `Retry downloading ${state.availableVersion}.`,
      };
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return {
        label: "Update install failed",
        detail: state.message?.trim() || `Retry installing ${state.downloadedVersion}.`,
      };
    }
    return {
      label: "Update check failed",
      detail: state.message?.trim() || "Unable to determine update status.",
    };
  }
  return {
    label: "Update status",
    detail: `Current version ${state.currentVersion}`,
  };
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    return state.message ?? "Update failed";
  }
  return "Update available";
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return result.accepted && !result.completed;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}
