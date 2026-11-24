import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SANDBOX_PROVIDER_KINDS = ["codesandbox", "upstash-box", "vercel-sandbox"] as const;
export const SandboxProviderKind = Schema.Literals(SANDBOX_PROVIDER_KINDS);
export type SandboxProviderKind = typeof SandboxProviderKind.Type;

const SANDBOX_STATES = [
  "creating",
  "bootstrapping",
  "running",
  "paused",
  "stopped",
  "snapshotting",
  "destroying",
  "error",
] as const;
export const SandboxState = Schema.Literals(SANDBOX_STATES);
export type SandboxState = typeof SandboxState.Type;

export const SandboxId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type SandboxId = typeof SandboxId.Type;

export const SandboxErrorCategory = Schema.Literals([
  "auth",
  "not_found",
  "rate_limit",
  "timeout",
  "command_failed",
  "invalid_state",
  "unconfigured",
  "unsupported",
  "provider_error",
  "persistence_error",
]);
export type SandboxErrorCategory = typeof SandboxErrorCategory.Type;

export class SandboxOperationError extends Schema.TaggedError<SandboxOperationError>()(
  "SandboxOperationError",
  {
    operation: Schema.Literals([
      "list",
      "spawn",
      "resume",
      "snapshot",
      "stop",
      "destroy",
      "status",
    ]),
    category: SandboxErrorCategory,
    provider: Schema.optional(SandboxProviderKind),
    sandboxId: Schema.optional(Schema.String),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const CloudSandboxRecord = Schema.Struct({
  id: SandboxId,
  provider: SandboxProviderKind,
  providerSandboxId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  snapshotId: Schema.NullOr(TrimmedNonEmptyString),
  baseSnapshotId: Schema.NullOr(TrimmedNonEmptyString),
  repoUrl: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  agentHarness: Schema.NullOr(TrimmedNonEmptyString),
  connectionUrl: Schema.NullOr(TrimmedNonEmptyString),
  environmentId: Schema.NullOr(EnvironmentId),
  state: SandboxState,
  idleTimeoutMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
  startedAt: Schema.NullOr(Schema.String),
  lastActivityAt: Schema.String,
  pausedAt: Schema.NullOr(Schema.String),
  vercelWarnedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CloudSandboxRecord = typeof CloudSandboxRecord.Type;

export const SandboxProviderAvailability = Schema.Struct({
  provider: SandboxProviderKind,
  configured: Schema.Boolean,
  defaultSnapshotId: Schema.NullOr(TrimmedNonEmptyString),
  reason: Schema.optional(Schema.String),
});
export type SandboxProviderAvailability = typeof SandboxProviderAvailability.Type;

export const SandboxListResult = Schema.Struct({
  sandboxes: Schema.Array(CloudSandboxRecord),
  providers: Schema.Array(SandboxProviderAvailability),
  defaultIdleTimeoutMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
});
export type SandboxListResult = typeof SandboxListResult.Type;

export const SandboxSpawnInput = Schema.Struct({
  provider: SandboxProviderKind,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  repoUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  branch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  agentHarness: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  snapshotId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  createBaseSnapshot: Schema.optional(Schema.Boolean),
  forwardHostOAuth: Schema.optional(Schema.Boolean),
  idleTimeoutMinutes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
  ),
  env: Schema.optional(Schema.Record(TrimmedNonEmptyString, Schema.String)),
});
export type SandboxSpawnInput = typeof SandboxSpawnInput.Type;

export const SandboxIdInput = Schema.Struct({
  id: SandboxId,
});
export type SandboxIdInput = typeof SandboxIdInput.Type;

export const SandboxSnapshotInput = Schema.Struct({
  id: SandboxId,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  markAsBase: Schema.optional(Schema.Boolean),
});
export type SandboxSnapshotInput = typeof SandboxSnapshotInput.Type;

export const SandboxSpawnResult = Schema.Struct({
  sandbox: CloudSandboxRecord,
  pairingUrl: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxSpawnResult = typeof SandboxSpawnResult.Type;

export const SandboxResumeResult = Schema.Struct({
  sandbox: CloudSandboxRecord,
  pairingUrl: Schema.optional(TrimmedNonEmptyString),
});
export type SandboxResumeResult = typeof SandboxResumeResult.Type;

export const SandboxSnapshotResult = Schema.Struct({
  sandbox: CloudSandboxRecord,
  snapshotId: TrimmedNonEmptyString,
});
export type SandboxSnapshotResult = typeof SandboxSnapshotResult.Type;

export const SandboxStopResult = Schema.Struct({
  sandbox: CloudSandboxRecord,
});
export type SandboxStopResult = typeof SandboxStopResult.Type;

export const SandboxDestroyResult = Schema.Struct({
  id: SandboxId,
});
export type SandboxDestroyResult = typeof SandboxDestroyResult.Type;

export const SandboxActivityReport = Schema.Struct({
  activeRunCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastRunActivityAt: Schema.NullOr(Schema.String),
});
export type SandboxActivityReport = typeof SandboxActivityReport.Type;
