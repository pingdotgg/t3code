import type {
  ChatAttachment,
  ComposerContextId,
  EnvironmentContextRecord,
  PreviewAnnotationPayload,
  ThreadContextRecord,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import type { ComposerHistoryRevision } from "../../composer-undo-grouping";
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

export interface QueuedImageHistoryState {
  currentRevision: number;
  readonly removedIdsByRevision: Map<number, ReadonlySet<string>>;
  readonly pendingRestoredIds: Set<string>;
}

export interface RetainedAttachmentContextPayloads {
  files: Map<string, ComposerFileAttachment>;
  previewAnnotations: Map<string, RetainedPreviewAnnotation>;
  queuedImageHistory: QueuedImageHistoryState;
}

export function createQueuedImageHistoryState(): QueuedImageHistoryState {
  return {
    currentRevision: 0,
    removedIdsByRevision: new Map(),
    pendingRestoredIds: new Set(),
  };
}

export function recordQueuedImageHistoryRevision(
  state: QueuedImageHistoryState,
  history: ComposerHistoryRevision,
  removedQueuedAttachments: ReadonlyArray<QueuedAttachmentContextBinding>,
): void {
  const active = new Set(history.activeRevisions);
  for (const revision of state.removedIdsByRevision.keys()) {
    if (!active.has(revision)) state.removedIdsByRevision.delete(revision);
  }
  const removedImageIds = new Set<string>();
  for (const entry of removedQueuedAttachments) {
    if (isQueuedImageAttachment(entry.attachment)) {
      removedImageIds.add(entry.attachment.id);
    }
  }
  for (const restoredId of state.pendingRestoredIds) {
    removedImageIds.delete(restoredId);
  }
  state.pendingRestoredIds.clear();
  state.currentRevision = history.revision;
  state.removedIdsByRevision.set(history.revision, removedImageIds);
}

export function recordChiplessQueuedImageRemoval(
  state: QueuedImageHistoryState,
  attachmentId: string,
): void {
  const next = new Set(state.removedIdsByRevision.get(state.currentRevision));
  next.add(attachmentId);
  state.removedIdsByRevision.set(state.currentRevision, next);
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
    queuedImageHistory: createQueuedImageHistoryState(),
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
      retained.terminals.clear();
      retained.reviewComments.clear();
      retained.threads.clear();
      retained.environments.clear();
      retained.files.clear();
      retained.previewAnnotations.clear();
      retained.queuedImageHistory.removedIdsByRevision.clear();
      retained.queuedImageHistory.pendingRestoredIds.clear();
    },
    [retained],
  );
  return retained;
}

export function reconcileAttachmentContextReferences(input: {
  referencedContextIds: ReadonlySet<string>;
  files: ReadonlyArray<ComposerFileAttachment>;
  queuedAttachments?: ReadonlyArray<QueuedAttachmentContextBinding>;
  removedQueuedAttachments?: ReadonlyArray<QueuedAttachmentContextBinding>;
  history?: ComposerHistoryRevision | undefined;
  textChanged?: boolean;
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

  const history = input.history;
  const removedQueuedAttachments = input.removedQueuedAttachments ?? [];
  if (history) {
    if (history.direction === null && input.textChanged) {
      recordQueuedImageHistoryRevision(
        input.retained.queuedImageHistory,
        history,
        removedQueuedAttachments,
      );
    } else if (history.direction !== null) {
      input.retained.queuedImageHistory.currentRevision = history.revision;
    }
  }

  const removedAtRevision =
    history?.direction != null
      ? input.retained.queuedImageHistory.removedIdsByRevision.get(history.revision)
      : undefined;

  const liveQueuedAttachments = input.queuedAttachments ?? [];
  const liveQueuedAttachmentIds = new Set<string>(
    liveQueuedAttachments.map((entry) => entry.attachment.id),
  );
  const queuedAttachmentIdsToRemove: string[] = [];
  for (const entry of liveQueuedAttachments) {
    if (entry.contextIds.length === 0) continue;
    if (entry.contextIds.some((contextId) => input.referencedContextIds.has(contextId))) continue;
    if (isQueuedFileAttachment(entry.attachment)) {
      queuedAttachmentIdsToRemove.push(entry.attachment.id);
    } else if (
      isQueuedImageAttachment(entry.attachment) &&
      removedAtRevision?.has(entry.attachment.id)
    ) {
      queuedAttachmentIdsToRemove.push(entry.attachment.id);
    }
  }
  const restoredQueuedAttachmentIds = new Set<string>();
  const queuedAttachmentsToRestore: ChatAttachment[] = [];
  for (const entry of removedQueuedAttachments) {
    if (
      entry.contextIds.length === 0 ||
      liveQueuedAttachmentIds.has(entry.attachment.id) ||
      restoredQueuedAttachmentIds.has(entry.attachment.id)
    ) {
      continue;
    }
    if (!entry.contextIds.some((contextId) => input.referencedContextIds.has(contextId))) continue;
    restoredQueuedAttachmentIds.add(entry.attachment.id);
    queuedAttachmentsToRestore.push(entry.attachment);
  }

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
