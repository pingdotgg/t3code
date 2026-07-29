import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";

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

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Server understands thread.snooze / thread.unsnooze commands. Absent on
      pre-snooze servers, so clients treat missing as unsupported and never
      send the commands under version skew. */
  threadSnooze: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const HostApplicationDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  buildNumber: TrimmedNonEmptyString,
  // "none" covers hosts that cannot self-update (dev builds, non-Sparkle
  // installs); clients only prompt for an update when the host says
  // "sparkle" — see hostNeedsMacAppUpdate.
  updateCapability: Schema.Literals(["sparkle", "none"]),
});
export type HostApplicationDescriptor = typeof HostApplicationDescriptor.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
  /** Present when the backend is supervised by a desktop app. Older hosts
      omit this field, allowing clients to detect version-reporting skew
      without confusing the server package version with the app version. */
  hostApplication: Schema.optional(HostApplicationDescriptor),
  advertisedEndpoints: Schema.optional(Schema.Array(AdvertisedEndpoint)),
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
