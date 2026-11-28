import type {
  ChatAttachment,
  ComposerContextId,
  EnvironmentContextRecord,
  PreviewAnnotationPayload,
  ThreadContextRecord,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { fileContextReference, previewAnnotationContextId } from "../../lib/composerContextRecords";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { isQueuedFileAttachment, isQueuedImageAttachment } from "./queuedMessageEdit";

interface RetainedPreviewAnnotation {
  annotation: PreviewAnnotationPayload;
  image: ComposerImageAttachment | undefined;
}

export interface QueuedAttachmentContextBinding {
  readonly attachment: ChatAttachment;
  readonly contextIds: ReadonlyArray<ComposerContextId>;
}

export interface RetainedAttachmentContextPayloads {
  files: Map<string, ComposerFileAttachment>;
  previewAnnotations: Map<string, RetainedPreviewAnnotation>;
  /** Queued images brought back because their chip reappeared. */
  restoredQueuedImageIds: Set<string>;
}

export interface RetainedContextPayloads extends RetainedAttachmentContextPayloads {
  terminals: Map<string, TerminalContextDraft>;
  reviewComments: Map<string, ReviewCommentContext>;
  threads: Map<string, ThreadContextRecord>;
  environments: Map<string, EnvironmentContextRecord>;
}

function createRetainedContextPayloads(): RetainedContextPayloads {
  return {
    terminals: new Map(),
    reviewComments: new Map(),
    threads: new Map(),
    environments: new Map(),
    files: new Map(),
    previewAnnotations: new Map(),
    restoredQueuedImageIds: new Set(),
  };
}

// Deleted chips keep their payloads until their draft's undo history ends.
export function useRetainedContextPayloads(draftTargetKey: string): RetainedContextPayloads {
  const [draft, setDraft] = useState(() => ({
    targetKey: draftTargetKey,
    payloads: createRetainedContextPayloads(),
  }));
  if (draft.targetKey !== draftTargetKey) {
    setDraft({ targetKey: draftTargetKey, payloads: createRetainedContextPayloads() });
  }
  const retained = draft.payloads;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the retained payload maps when the draft target changes or the composer unmounts
  useEffect(
    () => () => {
      for (const payloads of Object.values(retained)) payloads.clear();
    },
    [retained],
  );
  return retained;
}

export function reconcileAttachmentContextReferences(input: {
  referencedContextIds: ReadonlySet<string>;
  files: ReadonlyArray<ComposerFileAttachment>;
  /** Attachments of a queued message being edited, and those removed during the edit. */
  queuedAttachments?: ReadonlyArray<QueuedAttachmentContextBinding>;
  removedQueuedAttachments?: ReadonlyArray<QueuedAttachmentContextBinding>;
  /** The change came from undo or redo. */
  fromHistory?: boolean;
  images: ReadonlyArray<ComposerImageAttachment>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  retained: RetainedAttachmentContextPayloads;
}): {
  filesToRemove: string[];
  filesToRestore: ComposerFileAttachment[];
  queuedAttachmentIdsToRemove: string[];
  queuedAttachmentsToRestore: ChatAttachment[];
  annotationIdsToRemove: string[];
  annotationsToRestore: RetainedPreviewAnnotation[];
} {
  const liveFileContextIds = new Set<string>(
    input.files.map((file) => fileContextReference(file).contextId),
  );
  const filesToRemove: string[] = [];
  for (const file of input.files) {
    const contextId = fileContextReference(file).contextId;
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.files.set(contextId, file);
    filesToRemove.push(file.id);
  }
  const filesToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveFileContextIds.has(contextId)) return [];
    const file = input.retained.files.get(contextId);
    return file ? [file] : [];
  });

  const isReferenced = (entry: QueuedAttachmentContextBinding) =>
    entry.contextIds.some((contextId) => input.referencedContextIds.has(contextId));
  const restoredImageIds = input.retained.restoredQueuedImageIds;
  const queuedAttachmentIdsToRemove = (input.queuedAttachments ?? []).flatMap((entry) => {
    if (entry.contextIds.length === 0 || isReferenced(entry)) return [];
    if (isQueuedFileAttachment(entry.attachment)) return [entry.attachment.id];
    // Like draft images, a queued image outlives its deleted chip, unless undo or redo
    // takes away a chip whose return had brought the image back.
    const wasRestored = restoredImageIds.delete(entry.attachment.id);
    return wasRestored && input.fromHistory ? [entry.attachment.id] : [];
  });
  const queuedAttachmentsToRestore = (input.removedQueuedAttachments ?? []).flatMap((entry) => {
    if (!isReferenced(entry)) return [];
    if (isQueuedImageAttachment(entry.attachment)) restoredImageIds.add(entry.attachment.id);
    return [entry.attachment];
  });

  const imagesById = new Map(input.images.map((image) => [image.id, image]));
  const liveAnnotationContextIds = new Set<string>(
    input.previewAnnotations.map((annotation) => previewAnnotationContextId(annotation.id)),
  );
  const annotationIdsToRemove: string[] = [];
  for (const annotation of input.previewAnnotations) {
    const contextId = previewAnnotationContextId(annotation.id);
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.previewAnnotations.set(contextId, {
      annotation,
      image: imagesById.get(annotation.id),
    });
    annotationIdsToRemove.push(annotation.id);
  }
  const annotationsToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveAnnotationContextIds.has(contextId)) return [];
    const retained = input.retained.previewAnnotations.get(contextId);
    return retained ? [retained] : [];
  });

  return {
    filesToRemove,
    filesToRestore,
    queuedAttachmentIdsToRemove,
    queuedAttachmentsToRestore,
    annotationIdsToRemove,
    annotationsToRestore,
  };
}
