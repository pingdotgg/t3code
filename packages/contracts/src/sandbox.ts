import { Effect, Schema } from "effect";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SandboxId = TrimmedNonEmptyString.pipe(Schema.brand("SandboxId"));
export type SandboxId = typeof SandboxId.Type;

export const SandboxProviderKind = Schema.Literals(["local", "modal"]);
export type SandboxProviderKind = typeof SandboxProviderKind.Type;

export const SandboxProviderRef = Schema.Struct({
  providerKind: SandboxProviderKind,
  externalId: TrimmedNonEmptyString,
  appId: Schema.optional(TrimmedNonEmptyString),
  appName: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxProviderRef = typeof SandboxProviderRef.Type;

export const SandboxSnapshotId = TrimmedNonEmptyString.pipe(Schema.brand("SandboxSnapshotId"));
export type SandboxSnapshotId = typeof SandboxSnapshotId.Type;

export const SandboxServiceId = TrimmedNonEmptyString.pipe(Schema.brand("SandboxServiceId"));
export type SandboxServiceId = typeof SandboxServiceId.Type;

export const SandboxArtifactId = TrimmedNonEmptyString.pipe(Schema.brand("SandboxArtifactId"));
export type SandboxArtifactId = typeof SandboxArtifactId.Type;

export const SandboxLifecycleStatus = Schema.Literals([
  "requested",
  "queued",
  "provisioning",
  "starting",
  "ready",
  "running",
  "idle",
  "archiving",
  "archived",
  "failed",
  "terminated",
]);
export type SandboxLifecycleStatus = typeof SandboxLifecycleStatus.Type;

export const SandboxServiceStatus = Schema.Literals([
  "requested",
  "provisioning",
  "ready",
  "degraded",
  "failed",
  "stopped",
]);
export type SandboxServiceStatus = typeof SandboxServiceStatus.Type;

export const SandboxSnapshotStatus = Schema.Literals([
  "missing",
  "creating",
  "ready",
  "stale",
  "failed",
]);
export type SandboxSnapshotStatus = typeof SandboxSnapshotStatus.Type;

export const SandboxFailureKind = Schema.Literals([
  "provider_unavailable",
  "capacity_exhausted",
  "auth_failed",
  "snapshot_failed",
  "worktree_failed",
  "service_failed",
  "runtime_failed",
  "timeout",
  "invalid_request",
  "unknown",
]);
export type SandboxFailureKind = typeof SandboxFailureKind.Type;

export const SandboxFailureDescriptor = Schema.Struct({
  kind: SandboxFailureKind,
  message: TrimmedNonEmptyString,
  retryable: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  occurredAt: Schema.optional(IsoDateTime),
});
export type SandboxFailureDescriptor = typeof SandboxFailureDescriptor.Type;

const PositiveNumber = Schema.Number.check(Schema.isGreaterThan(0));

export const SandboxResourceSpec = Schema.Struct({
  cpu: Schema.optional(PositiveNumber),
  cpuLimit: Schema.optional(PositiveNumber),
  memoryMiB: Schema.optional(PositiveInt),
  memoryLimitMiB: Schema.optional(PositiveInt),
  gpu: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: Schema.optional(PositiveInt),
  idleTimeoutMs: Schema.optional(PositiveInt),
  regions: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SandboxResourceSpec = typeof SandboxResourceSpec.Type;

export const SandboxWorktreeDescriptor = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  baseCommit: Schema.optional(TrimmedNonEmptyString),
  headCommit: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxWorktreeDescriptor = typeof SandboxWorktreeDescriptor.Type;

export const SandboxSnapshotDescriptor = Schema.Struct({
  snapshotId: SandboxSnapshotId,
  providerRef: SandboxProviderRef,
  status: SandboxSnapshotStatus,
  projectKey: TrimmedNonEmptyString,
  sourceBranch: TrimmedNonEmptyString,
  sourceCommit: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  expiresAt: Schema.optional(IsoDateTime),
  setupSummary: Schema.optional(TrimmedNonEmptyString),
  failure: Schema.optional(SandboxFailureDescriptor),
});
export type SandboxSnapshotDescriptor = typeof SandboxSnapshotDescriptor.Type;

export const SandboxServiceKind = Schema.Literals([
  "t3-runtime",
  "convex",
  "dev-server",
  "browser",
  "terminal",
  "custom",
]);
export type SandboxServiceKind = typeof SandboxServiceKind.Type;

const SandboxMetadata = Schema.Record(Schema.String, Schema.Unknown);
export type SandboxMetadata = typeof SandboxMetadata.Type;

export const SandboxServiceEndpointProtocol = Schema.Literals([
  "http",
  "https",
  "ws",
  "wss",
  "tcp",
]);
export type SandboxServiceEndpointProtocol = typeof SandboxServiceEndpointProtocol.Type;

export const SandboxServiceEndpointAccessMode = Schema.Literals(["server", "browser", "private"]);
export type SandboxServiceEndpointAccessMode = typeof SandboxServiceEndpointAccessMode.Type;

export const SandboxServiceEndpointAuthKind = Schema.Literals([
  "none",
  "bridge-shared-secret",
  "provider-token",
  "credential-ref",
]);
export type SandboxServiceEndpointAuthKind = typeof SandboxServiceEndpointAuthKind.Type;

export const SandboxServiceEndpointAuth = Schema.Struct({
  kind: SandboxServiceEndpointAuthKind,
  credentialRef: Schema.optional(TrimmedNonEmptyString),
  expiresAt: Schema.optional(IsoDateTime),
});
export type SandboxServiceEndpointAuth = typeof SandboxServiceEndpointAuth.Type;

export const SandboxServiceEndpointDescriptor = Schema.Struct({
  url: TrimmedNonEmptyString,
  protocol: SandboxServiceEndpointProtocol,
  accessMode: SandboxServiceEndpointAccessMode,
  label: Schema.optional(TrimmedNonEmptyString),
  auth: Schema.optional(SandboxServiceEndpointAuth),
});
export type SandboxServiceEndpointDescriptor = typeof SandboxServiceEndpointDescriptor.Type;

export const SandboxServiceDescriptor = Schema.Struct({
  serviceId: SandboxServiceId,
  kind: SandboxServiceKind,
  status: SandboxServiceStatus,
  label: Schema.optional(TrimmedNonEmptyString),
  endpointUrl: Schema.optional(TrimmedNonEmptyString),
  healthCheckUrl: Schema.optional(TrimmedNonEmptyString),
  endpoints: Schema.optional(Schema.Array(SandboxServiceEndpointDescriptor)),
  metadata: Schema.optional(SandboxMetadata),
  failure: Schema.optional(SandboxFailureDescriptor),
});
export type SandboxServiceDescriptor = typeof SandboxServiceDescriptor.Type;

export const SandboxServiceRequest = Schema.Struct({
  serviceId: Schema.optional(SandboxServiceId),
  kind: SandboxServiceKind,
  required: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  label: Schema.optional(TrimmedNonEmptyString),
  metadata: Schema.optional(SandboxMetadata),
});
export type SandboxServiceRequest = typeof SandboxServiceRequest.Type;

export const SandboxArtifactKind = Schema.Literals([
  "log",
  "command-output",
  "diff",
  "screenshot",
  "trace",
  "archive",
  "custom",
]);
export type SandboxArtifactKind = typeof SandboxArtifactKind.Type;

export const SandboxArtifactDescriptor = Schema.Struct({
  artifactId: SandboxArtifactId,
  kind: SandboxArtifactKind,
  label: TrimmedNonEmptyString,
  url: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type SandboxArtifactDescriptor = typeof SandboxArtifactDescriptor.Type;

export const SandboxProjectDescriptor = Schema.Struct({
  repoName: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultBranch: TrimmedNonEmptyString,
  projectKey: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxProjectDescriptor = typeof SandboxProjectDescriptor.Type;

export const SandboxDescriptor = Schema.Struct({
  sandboxId: SandboxId,
  providerKind: SandboxProviderKind,
  providerRef: SandboxProviderRef,
  status: SandboxLifecycleStatus,
  taskId: TrimmedNonEmptyString,
  workSessionId: TrimmedNonEmptyString,
  project: SandboxProjectDescriptor,
  resources: SandboxResourceSpec,
  environment: Schema.optional(TrimmedNonEmptyString),
  worktree: Schema.optional(SandboxWorktreeDescriptor),
  snapshot: Schema.optional(SandboxSnapshotDescriptor),
  services: Schema.Array(SandboxServiceDescriptor).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  artifacts: Schema.Array(SandboxArtifactDescriptor).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  failure: Schema.optional(SandboxFailureDescriptor),
  idempotencyKey: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SandboxDescriptor = typeof SandboxDescriptor.Type;

export const SandboxRuntimeProviderConfig = Schema.Struct({
  appName: Schema.optional(TrimmedNonEmptyString),
  imageTag: Schema.optional(TrimmedNonEmptyString),
  runtimePort: Schema.optional(PositiveInt),
  bootstrapCommandRef: Schema.optional(TrimmedNonEmptyString),
  configVersion: Schema.optional(TrimmedNonEmptyString),
  allowedSecretNames: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  imageDockerfileCommands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SandboxRuntimeProviderConfig = typeof SandboxRuntimeProviderConfig.Type;

export const SandboxRuntimeSelection = Schema.Struct({
  providerKind: SandboxProviderKind.pipe(Schema.withDecodingDefault(Effect.succeed("local"))),
  resources: Schema.optional(SandboxResourceSpec),
  environment: Schema.optional(TrimmedNonEmptyString),
  providerConfig: Schema.optional(SandboxRuntimeProviderConfig),
});
export type SandboxRuntimeSelection = typeof SandboxRuntimeSelection.Type;
