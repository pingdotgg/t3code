import type { ChatAttachment, OrchestrationMessageContext } from "@t3tools/contracts";
import { composerRecallContext } from "@t3tools/shared/composerContextReferences";
import { resolveQueuedEditExit } from "@t3tools/client-runtime/queued-run-edit";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";

export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
}): "kept" | "discarded" | "clean" {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.editTarget);
  const recovery = resolveQueuedEditExit({
    editChanged:
      draft !== null &&
      (draft.prompt !== input.originalText || draft.images.length > 0 || draft.files.length > 0),
    threadDraftEmpty: !composerDraftHasUserContent(store.getComposerDraft(input.threadTarget)),
  });
  if (recovery === "kept") {
    store.moveComposerPromptAndImages(input.editTarget, input.threadTarget);
  } else {
    store.clearComposerContent(input.editTarget);
  }
  return recovery;
}

export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length)
    throw new Error("Retry or remove failed uploads before saving.");
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}

export function queuedEditContext(input: {
  readonly editing: {
    readonly originalText: string;
    readonly existingAttachments: ReadonlyArray<ChatAttachment>;
    readonly context?: OrchestrationMessageContext | undefined;
  };
  readonly sentText: string;
  readonly composerText: string;
  readonly newRecords: OrchestrationMessageContext["records"];
}): OrchestrationMessageContext {
  const { editing } = input;
  // Kept records for removed attachments would point at nothing.
  const keptRecords = (editing.context?.records ?? []).filter(
    (record) =>
      !("attachmentId" in record) ||
      editing.existingAttachments.some((attachment) => attachment.id === record.attachmentId),
  );
  return (
    composerRecallContext(
      input.sentText,
      input.composerText,
      {
        ...editing.context,
        version: 1,
        records: [
          ...new Map(
            [...keptRecords, ...input.newRecords].map(
              (record) => [record.contextId, record] as const,
            ),
          ).values(),
        ],
      },
      editing.originalText,
    ) ?? { version: 1, records: [] }
  );
}
