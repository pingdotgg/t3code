import { resolveQueuedEditExit } from "@t3tools/client-runtime/queued-run-edit";
import type { ChatAttachment } from "@t3tools/contracts";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";

/** Staged attachments upload as soon as they are added, so a dropped edit must release them. */
export function discardQueuedEditDraft(target: ComposerThreadTarget): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files]);
    for (const image of draft.images) {
      if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
    }
  }
  store.clearComposerContent(target);
}

export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  readonly removedExistingAttachment?: boolean;
}): "kept" | "discarded" | "clean" {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.editTarget);
  const recovery = resolveQueuedEditExit({
    editChanged:
      input.removedExistingAttachment === true ||
      (draft !== null &&
        (draft.prompt !== input.originalText || draft.images.length > 0 || draft.files.length > 0)),
    // A cleared edit has nothing to put back, so it can only be discarded.
    threadDraftEmpty:
      composerDraftHasUserContent(draft) &&
      !composerDraftHasUserContent(store.getComposerDraft(input.threadTarget)),
  });
  if (recovery === "kept") {
    store.moveComposerContent(input.editTarget, input.threadTarget);
    store.clearComposerContent(input.editTarget);
  } else {
    discardQueuedEditDraft(input.editTarget);
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
