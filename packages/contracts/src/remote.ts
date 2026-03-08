import { Schema } from "effect";
import { PositiveInt, RemoteHostId, TrimmedNonEmptyString } from "./baseSchemas";

export const ExecutionTarget = Schema.Literals(["local", "ssh-remote"]);
export type ExecutionTarget = typeof ExecutionTarget.Type;

export const ProjectLocationDisplay = Schema.Struct({
  executionTarget: ExecutionTarget,
  hostLabel: Schema.optional(TrimmedNonEmptyString),
  hostDescription: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
});
export type ProjectLocationDisplay = typeof ProjectLocationDisplay.Type;

export const RemoteHostRecord = Schema.Struct({
  id: RemoteHostId,
  label: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  port: PositiveInt,
  user: TrimmedNonEmptyString,
  identityFile: Schema.optional(TrimmedNonEmptyString),
  sshConfigHost: Schema.optional(TrimmedNonEmptyString),
  helperCommand: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(() => "t3 remote-agent --stdio"),
  ),
  helperVersion: Schema.NullOr(TrimmedNonEmptyString),
  lastConnectionAttemptAt: Schema.NullOr(Schema.String),
  lastConnectionSucceededAt: Schema.NullOr(Schema.String),
  lastConnectionFailedAt: Schema.NullOr(Schema.String),
  lastConnectionStatus: Schema.Literals(["unknown", "ok", "error"]).pipe(
    Schema.withDecodingDefault(() => "unknown"),
  ),
  lastConnectionError: Schema.NullOr(TrimmedNonEmptyString),
});
export type RemoteHostRecord = typeof RemoteHostRecord.Type;

export const RemoteHostUpsertInput = Schema.Struct({
  id: RemoteHostId,
  label: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  port: PositiveInt.pipe(Schema.withDecodingDefault(() => 22)),
  user: TrimmedNonEmptyString,
  identityFile: Schema.optional(TrimmedNonEmptyString),
  sshConfigHost: Schema.optional(TrimmedNonEmptyString),
  helperCommand: Schema.optional(TrimmedNonEmptyString),
});
export type RemoteHostUpsertInput = typeof RemoteHostUpsertInput.Type;

export const RemoteHostRemoveInput = Schema.Struct({
  remoteHostId: RemoteHostId,
});
export type RemoteHostRemoveInput = typeof RemoteHostRemoveInput.Type;

export const RemoteHostTestConnectionInput = Schema.Struct({
  remoteHostId: RemoteHostId,
});
export type RemoteHostTestConnectionInput = typeof RemoteHostTestConnectionInput.Type;

export const RemoteHostTestConnectionResult = Schema.Struct({
  remoteHostId: RemoteHostId,
  ok: Schema.Boolean,
  helperVersion: Schema.NullOr(TrimmedNonEmptyString),
  capabilities: Schema.Array(TrimmedNonEmptyString),
  checkedAt: Schema.String,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type RemoteHostTestConnectionResult = typeof RemoteHostTestConnectionResult.Type;

const RemoteWorkspaceEntryKind = Schema.Literals(["file", "directory"]);

export const RemoteWorkspaceEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: RemoteWorkspaceEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type RemoteWorkspaceEntry = typeof RemoteWorkspaceEntry.Type;

export const RemoteHostBrowseInput = Schema.Struct({
  remoteHostId: RemoteHostId,
  path: Schema.optional(TrimmedNonEmptyString),
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(200)).pipe(
    Schema.withDecodingDefault(() => 100),
  ),
});
export type RemoteHostBrowseInput = typeof RemoteHostBrowseInput.Type;

export const RemoteHostBrowseResult = Schema.Struct({
  remoteHostId: RemoteHostId,
  cwd: TrimmedNonEmptyString,
  entries: Schema.Array(RemoteWorkspaceEntry),
  truncated: Schema.Boolean,
});
export type RemoteHostBrowseResult = typeof RemoteHostBrowseResult.Type;

export const T3_REMOTE_HELPER_PROTOCOL_VERSION = 1 as const;
