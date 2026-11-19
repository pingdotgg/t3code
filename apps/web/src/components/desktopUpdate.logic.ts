import type {
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import type { UpdateCheckResult } from "@t3tools/client-runtime/update-check";
import { APP_NAME } from "@t3tools/shared/branding";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

// T3 Agents follows the fork's own releases, not upstream T3 Code's.
const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "jayleaton/ada";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

function desktopReleaseRepositoryUrl(repository: string | undefined): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_DESKTOP_RELEASE_REPOSITORY;
  return `https://github.com/${releaseRepository}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${desktopReleaseRepositoryUrl(repository)}/tag/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return `This Mac has Apple Silicon, but ${APP_NAME} is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.`;
  }
  if (action === "install") {
    return `This Mac has Apple Silicon, but ${APP_NAME} is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.`;
  }
  return `This Mac has Apple Silicon, but ${APP_NAME} is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.`;
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return `Update ${state.notAppliedVersion} did not apply. Click to retry.`;
  }
  if (
    (state.status === "available" || state.status === "error") &&
    state.errorContext === "download" &&
    state.availableVersion
  ) {
    return `Download failed for ${state.availableVersion}. Click to retry.`;
  }
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
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    if (state.downloadedVersion) {
      return `Update ${state.downloadedVersion} downloaded. Click to restart and install.`;
    }
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install update${version ? ` ${version}` : ""} and restart ${APP_NAME}?\n\nRunning turns pause first and resume after the restart.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "Automatic updates are not available in this build.";
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state, managedDenial);
  return disabledReason
    ? { title: "Updates unavailable", detail: disabledReason }
    : { title: "Check for updates", detail: null };
}

/** `managedDenial` is this machine's policy refusing updates; it explains a check that did not run. */
export function getDesktopUpdateCheckResult(
  { checked, state }: DesktopUpdateCheckResult,
  managedDenial?: string,
): UpdateCheckResult {
  const offered = getDesktopUpdateDownloadedVersion(state);
  if (
    offered !== null &&
    (state.status === "available" ||
      state.status === "downloading" ||
      state.status === "downloaded")
  ) {
    return { status: "available", version: offered };
  }
  if (!checked) {
    return {
      status: "error",
      reason:
        managedDenial ?? state.message ?? "Automatic updates are not available in this build.",
    };
  }
  if (state.status === "up-to-date") return { status: "up-to-date" };
  return { status: "error", reason: state.message ?? "The check did not finish." };
}
