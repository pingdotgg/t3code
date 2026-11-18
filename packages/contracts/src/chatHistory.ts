import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const CHAT_HISTORY_ARCHIVE_FORMAT = "t3code.chat-history";

export const ChatHistoryArchiveMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "reasoning"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ChatHistoryArchiveMessage = typeof ChatHistoryArchiveMessage.Type;

/** A project the archive's threads belong to, matched by folder on import. */
export const ChatHistoryArchiveProject = Schema.Struct({
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type ChatHistoryArchiveProject = typeof ChatHistoryArchiveProject.Type;

export const ChatHistoryArchiveThread = Schema.Struct({
  /** Kept on import, so importing a thread that already exists skips it. */
  id: ThreadId,
  /** Null for a thread without a project. */
  projectKey: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(ChatHistoryArchiveMessage),
});
export type ChatHistoryArchiveThread = typeof ChatHistoryArchiveThread.Type;

/** One file holding conversations, gzipped JSON on disk. */
export const ChatHistoryArchive = Schema.Struct({
  format: Schema.Literal(CHAT_HISTORY_ARCHIVE_FORMAT),
  version: Schema.Literal(1),
  exportedAt: IsoDateTime,
  projects: Schema.Array(ChatHistoryArchiveProject),
  threads: Schema.Array(ChatHistoryArchiveThread),
});
export type ChatHistoryArchive = typeof ChatHistoryArchive.Type;

export const ChatHistoryExportScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("all") }),
  Schema.Struct({ type: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ type: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type ChatHistoryExportScope = typeof ChatHistoryExportScope.Type;

export const ChatHistoryExportInput = Schema.Struct({ scope: ChatHistoryExportScope });
export type ChatHistoryExportInput = typeof ChatHistoryExportInput.Type;

export const ChatHistoryExportResult = Schema.Struct({
  /** A pending attachment holding the file; download it through an attachment asset URL. */
  attachmentId: TrimmedNonEmptyString,
  fileName: TrimmedNonEmptyString,
  threadCount: NonNegativeInt,
});
export type ChatHistoryExportResult = typeof ChatHistoryExportResult.Type;

export const ChatHistoryImportInput = Schema.Struct({
  /** A pending upload of an exported file. */
  attachmentId: TrimmedNonEmptyString,
});
export type ChatHistoryImportInput = typeof ChatHistoryImportInput.Type;

export const ChatHistoryImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  /** Threads that already exist here. */
  skippedCount: NonNegativeInt,
});
export type ChatHistoryImportResult = typeof ChatHistoryImportResult.Type;

export class ChatHistoryError extends Schema.TaggedError<ChatHistoryError>()("ChatHistoryError", {
  operation: Schema.Literals(["export", "import"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
