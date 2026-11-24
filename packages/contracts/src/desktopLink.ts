import * as Schema from "effect/Schema";

import { HostPowerSnapshot } from "./background.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopUpdateChannelSchema, DesktopUpdateStateSchema } from "./ipc.ts";

const DesktopHostPowerSnapshot = Schema.Struct({
  ...HostPowerSnapshot.fields,
  updatedAt: Schema.DateTimeUtcFromString,
});

export const DesktopLinkSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopLink"),
  sequence: NonNegativeInt,
  sampledAtUnixMs: NonNegativeInt,
  electronPid: PositiveInt,
  power: DesktopHostPowerSnapshot,
  speedLimitPercent: Schema.OptionFromNullOr(Schema.Number),
});
export type DesktopLinkSnapshot = typeof DesktopLinkSnapshot.Type;

export const DesktopLinkHello = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopLinkHello"),
  electronPid: PositiveInt,
});
export type DesktopLinkHello = typeof DesktopLinkHello.Type;

export const DesktopUpdateRemoteOutcome = Schema.Literals([
  "ready-to-install",
  "up-to-date",
  "failed",
]);
export type DesktopUpdateRemoteOutcome = typeof DesktopUpdateRemoteOutcome.Type;

export const DesktopUpdateStatusReport = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopUpdateStatus"),
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  preparedRequestId: Schema.optionalKey(TrimmedNonEmptyString),
  outcome: Schema.optionalKey(DesktopUpdateRemoteOutcome),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
  state: DesktopUpdateStateSchema,
});
export type DesktopUpdateStatusReport = typeof DesktopUpdateStatusReport.Type;

export const ShellEnvironmentPatch = Schema.Struct({
  PATH: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ANDROID_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ANDROID_SDK_ROOT: Schema.optionalKey(Schema.NullOr(Schema.String)),
  DBUS_SESSION_BUS_ADDRESS: Schema.optionalKey(Schema.NullOr(Schema.String)),
  DISPLAY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LANG: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LC_ALL: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LC_CTYPE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSH_AUTH_SOCK: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_PREFIX: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_CELLAR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_REPOSITORY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_CONFIG_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_CURRENT_DESKTOP: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_DATA_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_RUNTIME_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_SESSION_DESKTOP: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_SESSION_TYPE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  WAYLAND_DISPLAY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSL_CERT_FILE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSL_CERT_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  NODE_EXTRA_CA_CERTS: Schema.optionalKey(Schema.NullOr(Schema.String)),
  T3CODE_FEATURE_FLAGS: Schema.optionalKey(Schema.NullOr(Schema.String)),
  T3CODE_RELEASE_BASE_URL: Schema.optionalKey(Schema.NullOr(Schema.String)),
  __MISE_DIFF: Schema.optionalKey(Schema.NullOr(Schema.String)),
  JAVA_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  PNPM_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  FNM_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  FNM_MULTISHELL_PATH: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ShellEnvironmentPatch = typeof ShellEnvironmentPatch.Type;

export const DesktopShellEnvironmentSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("shellEnvironment"),
  discovered: Schema.Boolean,
  platform: Schema.String,
  environment: ShellEnvironmentPatch,
});
export type DesktopShellEnvironmentSnapshot = typeof DesktopShellEnvironmentSnapshot.Type;

export const DesktopLinkMessage = Schema.Union([
  DesktopLinkHello,
  DesktopShellEnvironmentSnapshot,
  DesktopLinkSnapshot,
  DesktopUpdateStatusReport,
]);
export type DesktopLinkMessage = typeof DesktopLinkMessage.Type;

export const DesktopLinkSetHostPowerIntervals = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("setHostPowerIntervals"),
  activeIntervalMs: PositiveInt,
  idleIntervalMs: PositiveInt,
});
export type DesktopLinkSetHostPowerIntervals = typeof DesktopLinkSetHostPowerIntervals.Type;

/** Runs check/download/quit-and-install without local confirmation; the remote RPC click supplies consent. */
export const DesktopLinkRequestDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("requestDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
  /** A track switch: move to this channel first, and install only `targetVersion`. */
  channel: Schema.optionalKey(DesktopUpdateChannelSchema),
  targetVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DesktopLinkRequestDesktopUpdate = typeof DesktopLinkRequestDesktopUpdate.Type;

export const DesktopLinkCommitDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("commitDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopLinkCommitDesktopUpdate = typeof DesktopLinkCommitDesktopUpdate.Type;

export const DesktopLinkCancelDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cancelDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopLinkCancelDesktopUpdate = typeof DesktopLinkCancelDesktopUpdate.Type;

/** The server accepts requests; the desktop treats this as backend readiness. */
export const DesktopLinkServerReady = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("serverReady"),
});
export type DesktopLinkServerReady = typeof DesktopLinkServerReady.Type;

export const DesktopLinkControlMessage = Schema.Union([
  DesktopLinkServerReady,
  DesktopLinkSetHostPowerIntervals,
  DesktopLinkRequestDesktopUpdate,
  DesktopLinkCommitDesktopUpdate,
  DesktopLinkCancelDesktopUpdate,
]);
export type DesktopLinkControlMessage = typeof DesktopLinkControlMessage.Type;
