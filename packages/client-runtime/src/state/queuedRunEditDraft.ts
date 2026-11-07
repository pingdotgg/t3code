import { CommandId, MessageId, OrchestrationMessageContext, RunId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const QueuedRunEditDraft = Schema.Struct({
  runId: RunId,
  messageId: MessageId,
  // File references can normalize composer text; compare newer saves against the server text.
  sourceText: Schema.String,
  originalText: Schema.String,
  originalAttachmentIds: Schema.Array(Schema.String),
  removedAttachmentIds: Schema.optional(Schema.Array(Schema.String)),
  context: Schema.optional(OrchestrationMessageContext),
  ownership: Schema.optional(
    Schema.Struct({
      editId: Schema.NullOr(CommandId),
      sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export type QueuedRunEditDraft = typeof QueuedRunEditDraft.Type;

export function queuedEditDraftHasMissingAttachments(
  draft: QueuedRunEditDraft,
  attachments: ReadonlyArray<{ readonly id: string }>,
): boolean {
  return draft.originalAttachmentIds.some(
    (id) =>
      !draft.removedAttachmentIds?.includes(id) &&
      !attachments.some((attachment) => attachment.id === id),
  );
}

export function queuedEditDraftMatchesSource(
  draft: QueuedRunEditDraft | undefined,
  text: string,
  attachments: ReadonlyArray<{ readonly id: string }>,
): boolean {
  return (
    draft !== undefined &&
    draft.sourceText === text &&
    draft.originalAttachmentIds.length === attachments.length &&
    draft.originalAttachmentIds.every((id, index) => id === attachments[index]?.id)
  );
}
