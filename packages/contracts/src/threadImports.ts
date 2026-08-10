import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ThreadImportProvider = Schema.Literals(["cursor", "claudeAgent", "codex", "grok"]);
export type ThreadImportProvider = typeof ThreadImportProvider.Type;

export const ThreadImportCandidateId = TrimmedNonEmptyString.pipe(
  Schema.brand("ThreadImportCandidateId"),
);
export type ThreadImportCandidateId = typeof ThreadImportCandidateId.Type;

export const ThreadImportMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadImportMessage = typeof ThreadImportMessage.Type;

export const ThreadImportProviderStatus = Schema.Struct({
  provider: ThreadImportProvider,
  available: Schema.Boolean,
  message: Schema.optional(TrimmedNonEmptyString),
  candidateCount: NonNegativeInt,
});
export type ThreadImportProviderStatus = typeof ThreadImportProviderStatus.Type;

export const ThreadImportCandidate = Schema.Struct({
  candidateId: ThreadImportCandidateId,
  provider: ThreadImportProvider,
  providerInstanceId: ProviderInstanceId,
  title: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  messageCount: NonNegativeInt,
  sourceLabel: TrimmedNonEmptyString,
  canResume: Schema.Boolean,
  resumeUnavailableReason: Schema.NullOr(TrimmedNonEmptyString),
  alreadyImported: Schema.Boolean,
  warnings: Schema.Array(TrimmedNonEmptyString),
});
export type ThreadImportCandidate = typeof ThreadImportCandidate.Type;

export const ThreadImportScanInput = Schema.Struct({
  projectId: ProjectId,
});
export type ThreadImportScanInput = typeof ThreadImportScanInput.Type;

export const ThreadImportScanResult = Schema.Struct({
  projectId: ProjectId,
  scannedAt: IsoDateTime,
  candidates: Schema.Array(ThreadImportCandidate),
  providers: Schema.Array(ThreadImportProviderStatus),
});
export type ThreadImportScanResult = typeof ThreadImportScanResult.Type;

export const ThreadImportCommitInput = Schema.Struct({
  projectId: ProjectId,
  candidateIds: Schema.Array(ThreadImportCandidateId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
});
export type ThreadImportCommitInput = typeof ThreadImportCommitInput.Type;

export const ThreadImportItemStatus = Schema.Literals([
  "imported",
  "already-imported",
  "transcript-only",
  "failed",
]);
export type ThreadImportItemStatus = typeof ThreadImportItemStatus.Type;

export const ThreadImportItemResult = Schema.Struct({
  candidateId: ThreadImportCandidateId,
  status: ThreadImportItemStatus,
  threadId: Schema.NullOr(ThreadId),
  importedMessageCount: NonNegativeInt,
  warnings: Schema.Array(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadImportItemResult = typeof ThreadImportItemResult.Type;

export const ThreadImportCommitResult = Schema.Struct({
  projectId: ProjectId,
  results: Schema.Array(ThreadImportItemResult),
});
export type ThreadImportCommitResult = typeof ThreadImportCommitResult.Type;

export const ThreadImportErrorCode = Schema.Literals([
  "project-not-found",
  "invalid-candidate",
  "source-unavailable",
  "provider-unavailable",
  "transcript-unreadable",
  "import-failed",
]);
export type ThreadImportErrorCode = typeof ThreadImportErrorCode.Type;

export class ThreadImportError extends Schema.TaggedErrorClass<ThreadImportError>()(
  "ThreadImportError",
  {
    code: ThreadImportErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
