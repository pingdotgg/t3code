import type { PreviewAnnotationPayload, ThreadContextRecord } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { fileContextReference, previewAnnotationContextId } from "../../lib/composerContextRecords";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";

interface RetainedPreviewAnnotation {
  annotation: PreviewAnnotationPayload;
  image: ComposerImageAttachment | undefined;
}

export interface RetainedAttachmentContextPayloads {
  files: Map<string, ComposerFileAttachment>;
  previewAnnotations: Map<string, RetainedPreviewAnnotation>;
}

export interface RetainedContextPayloads extends RetainedAttachmentContextPayloads {
  terminals: Map<string, TerminalContextDraft>;
  reviewComments: Map<string, ReviewCommentContext>;
  threads: Map<string, ThreadContextRecord>;
}

/**
 * Payloads for chips the prompt no longer references. History undo restores the
 * reference text but knows nothing about the draft records behind it, so a delete keeps its
 * payload here and an undo puts it back rather than leaving a dangling chip.
 *
 * Scoped to one draft: switching drafts or unmounting releases them, so deleted files do not
 * stay reachable for the composer's whole lifetime.
 */
export function useRetainedContextPayloads(draftTargetKey: string): RetainedContextPayloads {
  const [retained] = useState<RetainedContextPayloads>(() => ({
    terminals: new Map(),
    reviewComments: new Map(),
    threads: new Map(),
    files: new Map(),
    previewAnnotations: new Map(),
  }));
  useEffect(
    () => () => {
      for (const payloads of Object.values(retained)) payloads.clear();
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Switching drafts releases the previous draft's payloads.
    [draftTargetKey, retained],
  );
  return retained;
}

export function reconcileAttachmentContextReferences(input: {
  referencedContextIds: ReadonlySet<string>;
  files: ReadonlyArray<ComposerFileAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  retained: RetainedAttachmentContextPayloads;
}): {
  filesToRemove: string[];
  filesToRestore: ComposerFileAttachment[];
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

  return { filesToRemove, filesToRestore, annotationIdsToRemove, annotationsToRestore };
}
