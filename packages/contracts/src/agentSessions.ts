import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex", "pi"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** First adopt slice is Claude; Codex/Pi reuse the same shape when their UI lands. */
export const AgentSessionAdoptSource = Schema.Literal("claudeAgent");
export type AgentSessionAdoptSource = typeof AgentSessionAdoptSource.Type;

export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  // A decimal string keeps file IDs above 2^53 (common on NTFS) exact. Older
  // records stored a number.
  inode: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}

export const AgentSessionListInput = Schema.Struct({
  projectId: ProjectId,
  provider: Schema.optionalKey(AgentSessionAdoptSource),
});
export type AgentSessionListInput = typeof AgentSessionListInput.Type;

export const AgentSessionListed = Schema.Struct({
  provider: AgentSessionAdoptSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
  filePath: TrimmedNonEmptyString,
  importedThreadId: Schema.NullOr(ThreadId),
});
export type AgentSessionListed = typeof AgentSessionListed.Type;

export const AgentSessionListResult = Schema.Struct({
  sessions: Schema.Array(AgentSessionListed).check(Schema.isMaxLength(256)),
});
export type AgentSessionListResult = typeof AgentSessionListResult.Type;

export const AgentSessionAdoptInput = Schema.Struct({
  projectId: ProjectId,
  provider: AgentSessionAdoptSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024))),
});
export type AgentSessionAdoptInput = typeof AgentSessionAdoptInput.Type;

export const AgentSessionAdoptResult = Schema.Struct({
  threadId: ThreadId,
  adopted: Schema.Boolean,
});
export type AgentSessionAdoptResult = typeof AgentSessionAdoptResult.Type;

export class AgentSessionAdoptNotFoundError extends Schema.TaggedError<AgentSessionAdoptNotFoundError>()(
  "AgentSessionAdoptNotFoundError",
  {
    projectId: ProjectId,
    provider: AgentSessionAdoptSource,
    providerSessionId: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `No ${this.provider} session '${this.providerSessionId}' was found for project '${this.projectId}'.`;
  }
}

export class AgentSessionAdoptUnavailableError extends Schema.TaggedError<AgentSessionAdoptUnavailableError>()(
  "AgentSessionAdoptUnavailableError",
  {
    provider: AgentSessionAdoptSource,
    providerSessionId: TrimmedNonEmptyString,
    reason: Schema.Literals(["owned", "unresumable", "import_failed"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "owned":
        return `Session '${this.providerSessionId}' is already bound to another T3 thread.`;
      case "unresumable":
        return `Session '${this.providerSessionId}' cannot be resumed.`;
      case "import_failed":
        return `Could not adopt session '${this.providerSessionId}'.`;
    }
  }
}
