import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * A discoverable Codex conversation that belongs to a T3 project workspace.
 *
 * `importedThreadId` is deliberately a nullable T3 id rather than a boolean:
 * callers can both suppress duplicate imports and navigate to the existing
 * T3 thread without having to infer a second identity mapping.
 */
export const CodexSessionCandidate = Schema.Struct({
  externalThreadId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  preview: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  source: TrimmedNonEmptyString,
  archived: Schema.Boolean,
  importedThreadId: Schema.NullOr(ThreadId),
});
export type CodexSessionCandidate = typeof CodexSessionCandidate.Type;

export const CodexSessionListInput = Schema.Struct({
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
});
export type CodexSessionListInput = typeof CodexSessionListInput.Type;

export const CodexSessionListResult = Schema.Struct({
  sessions: Schema.Array(CodexSessionCandidate),
  /**
   * A safety cap prevented the server from scanning more sessions. The UI
   * exposes this rather than silently implying that the list is exhaustive.
   */
  truncated: Schema.Boolean,
});
export type CodexSessionListResult = typeof CodexSessionListResult.Type;

const CodexSessionImportThreadIds = Schema.Array(TrimmedNonEmptyString).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
);

export const CodexSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  externalThreadIds: CodexSessionImportThreadIds,
});
export type CodexSessionImportInput = typeof CodexSessionImportInput.Type;

export const CodexSessionImportResult = Schema.Struct({
  importedThreadIds: Schema.Array(ThreadId),
  alreadyImportedThreadIds: Schema.Array(ThreadId),
});
export type CodexSessionImportResult = typeof CodexSessionImportResult.Type;

/** A user-safe error surface for Codex discovery and import operations. */
export class CodexSessionImportError extends Schema.TaggedErrorClass<CodexSessionImportError>()(
  "CodexSessionImportError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
