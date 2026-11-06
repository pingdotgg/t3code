import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  EnvironmentId,
  RpcClientId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const BackgroundBooleanState = Schema.Literals(["true", "false", "unknown"]);
export type BackgroundBooleanState = typeof BackgroundBooleanState.Type;

export const HostPowerThermalState = Schema.Literals([
  "unknown",
  "nominal",
  "fair",
  "serious",
  "critical",
]);
export type HostPowerThermalState = typeof HostPowerThermalState.Type;

export const HostPowerSource = Schema.Literals([
  "unknown",
  "node-macos-shell",
  "node-macos-native",
  "node-linux",
  "node-windows",
  "electron-main",
]);
export type HostPowerSource = typeof HostPowerSource.Type;

export const HostPowerSnapshot = Schema.Struct({
  source: HostPowerSource,
  idle: BackgroundBooleanState,
  idleSeconds: Schema.NullOr(Schema.Number),
  locked: BackgroundBooleanState,
  suspended: Schema.Boolean,
  onBattery: BackgroundBooleanState,
  lowPowerMode: BackgroundBooleanState,
  thermalState: HostPowerThermalState,
  stale: Schema.Boolean,
  updatedAt: Schema.DateTimeUtc,
});
export type HostPowerSnapshot = typeof HostPowerSnapshot.Type;

export const BackgroundScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("server-config") }),
  Schema.Struct({
    type: Schema.Literal("provider-status"),
    instanceId: Schema.optionalKey(ProviderInstanceId),
  }),
  Schema.Struct({ type: Schema.Literal("vcs-status"), cwd: Schema.String }),
  Schema.Struct({ type: Schema.Literal("git-refs"), cwd: Schema.String }),
  Schema.Struct({ type: Schema.Literal("diagnostics") }),
  Schema.Struct({ type: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type BackgroundScope = typeof BackgroundScope.Type;

export const ClientKind = Schema.Literals(["web", "desktop-renderer", "mobile", "unknown"]);
export type ClientKind = typeof ClientKind.Type;

export const ClientActivityClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ClientActivityClientId = typeof ClientActivityClientId.Type;

export const ConnectionDiagnosticsSnapshot = Schema.Struct({
  milestones: Schema.Array(
    Schema.Literals([
      "config-decoded",
      "shell-headers",
      "shell-body",
      "shell-decoded",
      "shell-applied",
      "shell-synchronized",
    ]),
  ).check(Schema.isMaxLength(6)),
  rx: Schema.Number,
  tx: Schema.Number,
  closes: Schema.Number,
  errors: Schema.Number,
  binary: Schema.Number,
  firstFailure: Schema.optionalKey(
    Schema.Literals(["inflate", "json", "socket", "shell-body", "shell-schema"]),
  ),
  closeCode: Schema.optionalKey(Schema.Number),
});
export type ConnectionDiagnosticsSnapshot = typeof ConnectionDiagnosticsSnapshot.Type;

/** A failed or lost connection the client saw, reported once it reconnects so server logs show both sides. */
export const ConnectionTroubleEvent = Schema.Struct({
  at: Schema.Number,
  kind: Schema.Literals(["failed", "lost"]),
  attempt: Schema.Number,
  route: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  network: Schema.String.check(Schema.isMaxLength(16)),
  foreground: Schema.optionalKey(Schema.Boolean),
  stage: Schema.optionalKey(Schema.Literals(["preparing", "opening", "synchronizing"])),
  diagnostics: Schema.optionalKey(ConnectionDiagnosticsSnapshot),
  appState: Schema.optionalKey(Schema.Literals(["active", "inactive", "background", "unknown"])),
});
export type ConnectionTroubleEvent = typeof ConnectionTroubleEvent.Type;

export const ClientActivityReportInput = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  clientId: ClientActivityClientId,
  clientKind: ClientKind,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
  recentlyInteracted: Schema.Boolean,
  appState: Schema.optionalKey(Schema.Literals(["active", "inactive", "background", "unknown"])),
  lowPowerMode: Schema.optionalKey(BackgroundBooleanState),
  scopes: Schema.Array(BackgroundScope),
  ttlMs: Schema.optionalKey(Schema.Number),
  observedAt: Schema.DateTimeUtc,
  connectionTrouble: Schema.optionalKey(
    Schema.Array(ConnectionTroubleEvent).check(Schema.isMaxLength(10)),
  ),
});
export type ClientActivityReportInput = typeof ClientActivityReportInput.Type;

export const ClientActivityLease = Schema.Struct({
  sessionId: AuthSessionId,
  rpcClientId: RpcClientId,
  clientId: ClientActivityClientId,
  clientKind: ClientKind,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
  recentlyInteracted: Schema.Boolean,
  appState: Schema.optionalKey(Schema.Literals(["active", "inactive", "background", "unknown"])),
  lowPowerMode: Schema.optionalKey(BackgroundBooleanState),
  scopes: Schema.Array(BackgroundScope),
  updatedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type ClientActivityLease = typeof ClientActivityLease.Type;

export const BackgroundPolicySnapshot = Schema.Struct({
  hostPower: HostPowerSnapshot,
  leases: Schema.Array(ClientActivityLease),
  activeForegroundLeaseCount: Schema.Number,
  activeScopeKeys: Schema.Array(Schema.String),
  shouldRunOpportunisticWork: Schema.Boolean,
  updatedAt: Schema.DateTimeUtc,
});
export type BackgroundPolicySnapshot = typeof BackgroundPolicySnapshot.Type;
