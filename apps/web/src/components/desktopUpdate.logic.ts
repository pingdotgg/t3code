import { desktopTrackMismatchText } from "@t3tools/client-runtime/state/server";
import type {
  DesktopBridge,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";
import { channelSwitchLabel } from "./sidebar/updateEverything.logic";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DEFAULT_DESKTOP_RELEASE_REPOSITORY = "pingdotgg/t3code";
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

export function getArm64IntelBuildWarningDescription(
  state: DesktopUpdateState,
  resolve: MessageResolver = m,
): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return resolve(msg("This install is using the correct architecture."));
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return resolve(
      msg(
        "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
      ),
    );
  }
  if (action === "install") {
    return resolve(
      msg(
        "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
      ),
    );
  }
  return resolve(
    msg(
      "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
    ),
  );
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  resolve: MessageResolver = m,
): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return resolve(
      msg("Update {version} did not apply. Click to retry.", { version: state.notAppliedVersion }),
    );
  }
  if (
    (state.status === "available" || state.status === "error") &&
    state.errorContext === "download" &&
    state.availableVersion
  ) {
    return resolve(
      msg("Download failed for {version}. Click to retry.", { version: state.availableVersion }),
    );
  }
  if (state.status === "available") {
    return state.availableVersion === null
      ? resolve(msg("Update available ready to download"))
      : resolve(msg("Update {version} ready to download", { version: state.availableVersion }));
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? resolve(
          msg("Downloading update ({percent}%)", { percent: Math.floor(state.downloadPercent) }),
        )
      : resolve(msg("Downloading update"));
  }
  if (state.status === "downloaded") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return resolve(
        msg("Install failed for {version}. Click to retry.", { version: state.downloadedVersion }),
      );
    }
    const version = state.downloadedVersion ?? state.availableVersion;
    return version === null
      ? resolve(msg("Update ready downloaded. Click to restart and install."))
      : resolve(msg("Update {version} downloaded. Click to restart and install.", { version }));
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return resolve(
        msg("Install failed for {version}. Click to retry.", { version: state.downloadedVersion }),
      );
    }
    if (state.downloadedVersion) {
      return resolve(
        msg("Update {version} downloaded. Click to restart and install.", {
          version: state.downloadedVersion,
        }),
      );
    }
    if (state.trackMismatch !== undefined) {
      return resolve(
        desktopTrackMismatchText({
          buildChannel: state.trackMismatch.buildChannel,
          savedChannel: state.channel,
        }),
      );
    }
    return state.message ?? resolve(msg("Update failed"));
  }
  // The updater discards every release of the other track, so "up to date" would be false here.
  const buildChannel = desktopUpdateChannelOf(state.currentVersion);
  if (state.status === "up-to-date" && buildChannel !== state.channel) {
    return resolve(
      msg(
        "This {build} build ignores {track} releases. Review the update track in Settings to finish the switch.",
        {
          build: channelSwitchLabel(buildChannel, resolve),
          track: channelSwitchLabel(state.channel, resolve),
        },
      ),
    );
  }
  return resolve(msg("Up to date"));
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  resolve: MessageResolver = m,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return version
    ? resolve(
        msg(
          "Install update {version} and restart T3 Code?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
          { version },
        ),
      )
    : resolve(
        msg(
          "Install update and restart T3 Code?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
        ),
      );
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

/**
 * macOS can refuse the restart after installUpdate resolves; the desktop then reports it as a
 * later state with errorContext "install". Success quits the app, so this never resolves then.
 */
export async function installDesktopUpdate(
  bridge: Pick<DesktopBridge, "installUpdate" | "onUpdateState">,
  expectedVersion?: string,
): Promise<DesktopUpdateActionResult> {
  let awaitingFailure = false;
  let reportFailure: (state: DesktopUpdateState) => void = () => {};
  const failure = new Promise<DesktopUpdateState>((resolve) => {
    reportFailure = resolve;
  });
  const unsubscribe = bridge.onUpdateState((state) => {
    if (awaitingFailure && state.errorContext === "install") reportFailure(state);
  });
  try {
    const result = await bridge.installUpdate(expectedVersion);
    if (!result.accepted || result.completed || getDesktopUpdateActionError(result) !== null) {
      return result;
    }
    awaitingFailure = true;
    return { ...result, state: await failure };
  } finally {
    unsubscribe();
  }
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

/** `managedDenial` is this machine's policy refusing updates (`managedUpdatesDenial`); it wins. */
export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
  resolve: MessageResolver = m,
): string | null {
  if (managedDenial !== undefined) return managedDenial;
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return (
    state.message?.trim() || resolve(msg("Automatic updates are not available in this build."))
  );
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
  managedDenial?: string,
  resolve: MessageResolver = m,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state, managedDenial, resolve);
  return disabledReason
    ? { title: resolve(msg("Updates unavailable")), detail: disabledReason }
    : { title: resolve(msg("Check for updates")), detail: null };
}
