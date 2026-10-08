import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const SESSION_TRANSFER_MAX_BYTES = 100 * 1024 * 1024;
export const SESSION_TRANSFER_EXCLUDED_DIRECTORIES = [
  "node_modules",
  ".t3",
  ".next",
  ".cache",
] as const;
export const SessionTransferExportInput = Schema.Struct({ threadId: ThreadId });
export const SessionTransferExportResult = Schema.Struct({
  transferId: TrimmedNonEmptyString,
  attachmentId: TrimmedNonEmptyString,
  sizeBytes: Schema.Number,
});
export const SessionTransferImportInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
});
export const SessionTransferImportResult = Schema.Struct({
  threadId: ThreadId,
  workspaceRoot: Schema.String,
  contextPrompt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export const SessionTransferFinishInput = Schema.Struct({
  threadId: ThreadId,
  transferId: TrimmedNonEmptyString,
});
export class SessionTransferError extends Schema.TaggedError<SessionTransferError>()(
  "SessionTransferError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
export type SessionTransferExportInput = typeof SessionTransferExportInput.Type;
export type SessionTransferExportResult = typeof SessionTransferExportResult.Type;
export type SessionTransferImportInput = typeof SessionTransferImportInput.Type;
export type SessionTransferImportResult = typeof SessionTransferImportResult.Type;
export type SessionTransferFinishInput = typeof SessionTransferFinishInput.Type;
