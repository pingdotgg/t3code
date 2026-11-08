import {
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

export const CHANNEL_CHANGE_RETRY_DELAY = Duration.seconds(1);
export const CHANNEL_CHANGE_RETRIES = 30;
export const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
export const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";
export const PREPARED_INSTALL_CHECK_WAIT = Duration.seconds(90);

export type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

export interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

export const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
export type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Malformed notes must not block update-state decoding; normalizeDesktopUpdateReleaseNotes validates separately.
  releaseNotes: Schema.optional(Schema.Unknown),
  releaseDate: Schema.optional(Schema.String),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";
const DesktopUpdateInstallRecord = Schema.fromJsonString(
  Schema.Struct({ fromVersion: Schema.String, targetVersion: Schema.String }),
);
export const decodeInstallRecord = Schema.decodeUnknownEffect(DesktopUpdateInstallRecord);
export const encodeInstallRecord = Schema.encodeEffect(DesktopUpdateInstallRecord);

const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
export const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
export const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

export const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export class DesktopUpdateChannelManagedError extends Schema.TaggedError<DesktopUpdateChannelManagedError>()(
  "DesktopUpdateChannelManagedError",
  {
    channel: DesktopUpdateChannelSchema,
    policyMessage: Schema.String,
  },
) {
  override get message(): string {
    return `${this.policyMessage} The ${this.channel} channel is not available.`;
  }
}

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
  DesktopUpdateChannelManagedError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function redactMessage(message: string): string {
  return (message.split(/[\r\n]/, 1)[0] ?? "")
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted credential]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*$/gi,
      "[redacted header]",
    )
    .replace(
      /\b[\w-]*(?:token|password|secret|credential|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[redacted credential]",
    )
    .slice(0, 512);
}

function summarizeCause(cause: unknown, depth: number): string {
  if (depth >= 3) return "[truncated cause]";
  if (Cause.isCause(cause)) {
    return cause.reasons
      .slice(0, 3)
      .map((reason) =>
        reason._tag === "Fail"
          ? summarizeCause(reason.error, depth + 1)
          : reason._tag === "Die"
            ? summarizeCause(reason.defect, depth + 1)
            : "Interrupted",
      )
      .join("; ");
  }
  if (typeof cause === "string") return redactMessage(cause);
  if (typeof cause !== "object" || cause === null) return errorTag(cause);

  const error = cause as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  const code =
    typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
      ? ` [${error.code}]`
      : "";
  const message = typeof error.message === "string" ? `: ${redactMessage(error.message)}` : "";
  const nested =
    error.cause === undefined ? "" : `; caused by ${summarizeCause(error.cause, depth + 1)}`;
  return `${errorTag(cause)}${code}${message}${nested}`;
}

export function describeUpdateErrorCause(cause: unknown): string {
  try {
    return summarizeCause(cause, 0).slice(0, 1024);
  } catch {
    return "UnknownError";
  }
}

export function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

export function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  disabledReason: Option.Option<string>,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  const enabled = Option.isNone(disabledReason);
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
    message: Option.getOrNull(disabledReason),
  };
}

export function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

export function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

export function getAutoUpdateDisabledReason(args: {
  policy: DesktopUpdatePolicy.UpdatePolicy;
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (args.policy.mode === "off") {
    return args.policy.message ?? "Updates are turned off on this machine.";
  }
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

export function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}
