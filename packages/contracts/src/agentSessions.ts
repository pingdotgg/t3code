import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/** Imported message ids retain their origin after event metadata is projected into SQLite. */
export function isImportedAgentSessionMessageId(messageId: string): boolean {
  return messageId.startsWith("import:");
}

/**
 * Empty for now. Kept as a struct so future scan options (source filters,
 * explicit roots) can be added without a new method.
 */
export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * T3 Code project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
/**
 * Git identity of a candidate directory, read from `.git/config` without
 * spawning git. `remoteKey` is the normalized origin URL, shared by every
 * clone of the same repository so the client can group them. `repository`
 * is the GitHub `owner/name` when the origin is on GitHub.
 */
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
  /**
   * `null` when the directory is not the root of a git repository. Missing on
   * servers that predate the git scan, where the client cannot tell repositories
   * from plain folders and should treat every candidate as a standalone project.
   */
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

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedErrorClass<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedErrorClass<AgentSessionImportProjectChangedError>()(
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

export const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AgentSessionSelection = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString.check(Schema.isPattern(CLAUDE_SESSION_ID_PATTERN)),
});
export type AgentSessionSelection = typeof AgentSessionSelection.Type;

export const AgentSessionListInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: TrimmedNonEmptyString,
  cursor: Schema.optional(Schema.String),
});
export type AgentSessionListInput = typeof AgentSessionListInput.Type;

export const AgentSessionAttachInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: TrimmedNonEmptyString,
  ...AgentSessionSelection.fields,
});
export type AgentSessionAttachInput = typeof AgentSessionAttachInput.Type;

export const AgentSessionPreviewInput = Schema.Struct({
  ...AgentSessionAttachInput.fields,
  before: Schema.optional(NonNegativeInt),
});
export type AgentSessionPreviewInput = typeof AgentSessionPreviewInput.Type;

export const AgentSessionSummary = Schema.Struct({
  ...AgentSessionSelection.fields,
  title: Schema.String,
  firstRequest: Schema.String,
  updatedAt: IsoDateTime,
  cwd: TrimmedNonEmptyString,
  branch: Schema.NullOr(Schema.String),
  existingThreadId: Schema.NullOr(ThreadId),
});
export type AgentSessionSummary = typeof AgentSessionSummary.Type;

export const AgentSessionListResult = Schema.Struct({
  sessions: Schema.Array(AgentSessionSummary),
  nextCursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
});
export type AgentSessionListResult = typeof AgentSessionListResult.Type;

export const AgentSessionPreviewResult = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      id: NonNegativeInt,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoDateTime,
    }),
  ),
  nextBefore: Schema.NullOr(NonNegativeInt),
  truncated: Schema.Boolean,
});
export type AgentSessionPreviewResult = typeof AgentSessionPreviewResult.Type;
export const AgentSessionAttachResult = Schema.Struct({ threadId: ThreadId });

export class AgentSessionUnavailableError extends Schema.TaggedErrorClass<AgentSessionUnavailableError>()(
  "AgentSessionUnavailableError",
  { message: Schema.String },
) {}

export class AgentSessionScanError extends Schema.TaggedErrorClass<AgentSessionScanError>()(
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
