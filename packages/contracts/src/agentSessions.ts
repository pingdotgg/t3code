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

const AgentSessionHistoryCursor = Schema.Struct({
  discovery: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
  updatedAt: IsoDateTime,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
});

export const AgentSessionHistoryInput = Schema.Struct({
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(AgentSessionHistoryCursor),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type AgentSessionHistoryInput = typeof AgentSessionHistoryInput.Type;

export const AgentSessionRecap = Schema.Struct({
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  nextAction: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
});
export type AgentSessionRecap = typeof AgentSessionRecap.Type;

export const AgentSessionHistoryResult = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      provider: AgentSessionSource,
      providerInstanceId: ProviderInstanceId,
      providerSessionId: TrimmedNonEmptyString,
      workspaceRoot: TrimmedNonEmptyString,
      title: TrimmedNonEmptyString,
      recentExcerpt: Schema.optional(Schema.String),
      recap: Schema.optional(AgentSessionRecap),
      updatedAt: IsoDateTime,
    }),
  ),
  nextCursor: Schema.NullOr(AgentSessionHistoryCursor),
  scannedAt: IsoDateTime,
  truncated: Schema.Boolean,
});
export type AgentSessionHistoryResult = typeof AgentSessionHistoryResult.Type;

const AgentSessionReference = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
});

const AgentSessionPreviewCursor = Schema.Struct({
  revision: TrimmedNonEmptyString,
  before: NonNegativeInt,
  // With byteOffset, zero starts a new window; positive values page within it.
  byteOffset: Schema.optional(NonNegativeInt),
  textBefore: Schema.optional(NonNegativeInt),
  scan: Schema.optional(TrimmedNonEmptyString),
});

export const AgentSessionPreviewInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  session: AgentSessionReference,
  cursor: Schema.optional(AgentSessionPreviewCursor),
});
export type AgentSessionPreviewInput = typeof AgentSessionPreviewInput.Type;

export const AgentSessionPreviewResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["unreadable", "changed"]),
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    revision: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    model: Schema.NullOr(Schema.String),
    recap: Schema.optional(AgentSessionRecap),
    boundedWindow: Schema.optional(Schema.Boolean),
    messages: Schema.Array(
      Schema.Struct({
        id: TrimmedNonEmptyString,
        role: Schema.Literals(["user", "assistant"]),
        text: Schema.String,
        truncated: Schema.Boolean,
        createdAt: IsoDateTime,
      }),
    ),
    nextCursor: Schema.NullOr(AgentSessionPreviewCursor),
  }),
]);
export type AgentSessionPreviewResult = typeof AgentSessionPreviewResult.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
  session: Schema.optional(AgentSessionReference),
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
  threadId: Schema.optional(ThreadId),
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals([
      "read-settings",
      "read-projects",
      "discover-sessions",
      "discovery-cursor",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.operation === "discovery-cursor"
      ? "Session discovery expired or changed. Return to Newest to restart."
      : `Failed to scan agent sessions during ${this.operation}.`;
  }
}
