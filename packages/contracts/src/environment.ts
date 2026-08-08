import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

/** How a server can replace itself with another version when asked over RPC.
    New servers only advertise the stable launcher-backed "boot-service" path;
    "respawn" remains decodable for compatibility with older servers. */
export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

/** What update path a client should offer for a server: one of the RPC
    self-update methods above, or "desktop-managed" when the backend's
    version belongs to the T3 Code desktop app supervising it — updating the
    app on that machine is the only way to update the server. */
export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.settle / thread.unsettle commands. Absent on
      pre-settlement servers, so clients treat missing as unsupported and
      never send the commands under version skew. */
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  /** Server derives settled state itself (auto-settle sweep + the
      threadAutoSettleAfterDays server setting). Clients gate the auto-settle
      settings UI on this; settled classification itself is just
      settledOverride and needs no gate. */
  threadAutoSettle: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.snooze / thread.unsnooze commands. Same
      version-skew contract as threadSettlement. */
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pin / thread.unpin commands. Same
      version-skew contract as threadSettlement. */
  threadPinning: Schema.optionalKey(Schema.Boolean),
  /** Server understands thread.pin.reorder (and orderKey on thread.pin).
      Same version-skew contract as threadSettlement. */
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  /** Server understands regenerateTitle on thread.meta.update. Absent on
      older servers, so clients hide the action instead of sending it. */
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  /** The update path clients should offer for this server. Absent on
      servers that must be relaunched manually (dev checkouts, Windows
      foreground runs, pre-update servers). */
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Server can stream self-update progress before acknowledging the
      restart. Clients fall back to server.updateServer when absent. */
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const EnvironmentConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type EnvironmentConnectionState = typeof EnvironmentConnectionState.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;

export const ScopedThreadSessionRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadSessionRef = typeof ScopedThreadSessionRef.Type;
