import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import {
  composerFileNeedsReattach,
  composerTargetKey,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m } from "../../i18n/messages";
import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { attachmentUploadFailureText } from "../../lib/attachmentUploadState";
import { composerDraftContentChanged } from "./composerSend.logic";

export interface PreparingComposerImage {
  readonly id: string;
  readonly name: string;
  /** The uncompressed source, thumbnailed so the placeholder shows the image itself. */
  readonly file: File;
  /** Looks like an image the draft already has: it holds its slot but shows no tile. */
  readonly hidden: boolean;
}

const NO_PREPARING_IMAGES: ReadonlyArray<PreparingComposerImage> = [];

/**
 * Images accepted into a draft but still being compressed, keyed by attachment target. Large
 * screenshots take a noticeable moment to re-encode, so the strip shows these right away and
 * they hold their attachment slots until the real image joins the draft.
 */
const usePreparingComposerImageStore = create<{
  readonly byTargetKey: Readonly<Record<string, ReadonlyArray<PreparingComposerImage>>>;
}>(() => ({ byTargetKey: {} }));

const movedImageThreads = new WeakMap<PreparingComposerImage, ScopedThreadRef>();

export function movedPreparingImageThread(image: PreparingComposerImage) {
  return movedImageThreads.get(image);
}

/** Carries the live tiles to the thread, where they can still be removed or awaited. */
export function movePreparingComposerImagesToThread(
  sourceKey: string,
  thread: ScopedThreadRef,
): void {
  const images = getPreparingComposerImages(sourceKey);
  if (images.length === 0) return;
  const threadKey = scopedThreadKey(thread);
  for (const image of images) movedImageThreads.set(image, thread);
  invalidatePendingSubmit(sourceKey);
  usePreparingComposerImageStore.setState(({ byTargetKey }) => {
    const next = { ...byTargetKey };
    delete next[sourceKey];
    next[threadKey] = [...(next[threadKey] ?? NO_PREPARING_IMAGES), ...images];
    return { byTargetKey: next };
  });
}

export function usePreparingComposerImages(targetKey: string) {
  return usePreparingComposerImageStore(
    (state) => state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES,
  );
}

export function getPreparingComposerImages(
  targetKey: string,
): ReadonlyArray<PreparingComposerImage> {
  return usePreparingComposerImageStore.getState().byTargetKey[targetKey] ?? NO_PREPARING_IMAGES;
}

export function countPreparingComposerImages(targetKey: string): number {
  return getPreparingComposerImages(targetKey).length;
}

export function addPreparingComposerImages(
  targetKey: string,
  images: ReadonlyArray<PreparingComposerImage>,
): void {
  if (images.length > 0) {
    heldSends.get(targetKey)?.({ status: "cancelled" });
  }
  usePreparingComposerImageStore.setState((state) => ({
    byTargetKey: {
      ...state.byTargetKey,
      [targetKey]: [...(state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES), ...images],
    },
  }));
}

export function isPreparingComposerImage(targetKey: string, imageId: string): boolean {
  return (
    usePreparingComposerImageStore
      .getState()
      .byTargetKey[targetKey]?.some((image) => image.id === imageId) ?? false
  );
}

/** Returns the ids that were still preparing; any other id was cancelled from the strip. */
export function removePreparingComposerImages(
  targetKey: string,
  imageIds: ReadonlySet<string>,
  options?: { readonly cancelSubmission?: boolean },
): ReadonlySet<string> {
  const current =
    usePreparingComposerImageStore.getState().byTargetKey[targetKey] ?? NO_PREPARING_IMAGES;
  const removed = new Set(
    current.filter((image) => imageIds.has(image.id)).map((image) => image.id),
  );
  if (removed.size === 0) return removed;
  if (options?.cancelSubmission) invalidatePendingSubmit(targetKey);
  usePreparingComposerImageStore.setState((state) => {
    const remaining = (state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES).filter(
      (image) => !removed.has(image.id),
    );
    const byTargetKey = { ...state.byTargetKey };
    if (remaining.length > 0) {
      byTargetKey[targetKey] = remaining;
    } else {
      delete byTargetKey[targetKey];
    }
    return { byTargetKey };
  });
  return removed;
}

// Bumped on cancel so a send held for the cancelled images is dropped rather than released.
const cancelGenerations = new Map<string, number>();

export type HeldComposerSendResult =
  | { readonly status: "ready" }
  | { readonly status: "cancelled" }
  | { readonly status: "upload-failed"; readonly reason: string };

const heldSends = new Map<string, (result: HeldComposerSendResult) => void>();
const useHeldSendStore = create<{ readonly targetKeys: Readonly<Record<string, true>> }>(() => ({
  targetKeys: {},
}));
let preparedImagesJoiningDraft = false;

function invalidatePendingSubmit(targetKey: string) {
  cancelGenerations.set(targetKey, (cancelGenerations.get(targetKey) ?? 0) + 1);
  heldSends.get(targetKey)?.({ status: "cancelled" });
}

/** Whether a send from the target's draft is waiting on its attachments. */
export function useComposerSendHeld(targetKey: string): boolean {
  return useHeldSendStore((state) => state.targetKeys[targetKey] === true);
}

export function cancelHeldComposerSend(targetKey: string): void {
  heldSends.get(targetKey)?.({ status: "cancelled" });
}

/** Inserts finished images into the draft without counting as an edit to a held send. */
export function joinPreparedImagesToDraft(insert: () => void): void {
  preparedImagesJoiningDraft = true;
  try {
    insert();
  } finally {
    preparedImagesJoiningDraft = false;
  }
}

/**
 * Holds a send made while the draft still has images compressing or, with `uploadEnvironmentId`,
 * attachments still uploading. Resolves ready once they finish, cancelled if edited/cancelled,
 * or upload-failed if an upload fails. Null means nothing needs to wait. Lives outside the
 * composer so leaving the thread still completes the send.
 */
export function holdComposerSend(
  draftTarget: ComposerThreadTarget,
  uploadEnvironmentId: EnvironmentId | null,
): Promise<HeldComposerSendResult> | null {
  const targetKey = composerTargetKey(draftTarget);
  const uploadableAttachments = () => {
    const draft = useComposerDraftStore.getState().getComposerDraft(draftTarget);
    if (!draft) return [];
    return [...draft.images, ...draft.files.filter((file) => !composerFileNeedsReattach(file))];
  };
  const needsUpload =
    uploadEnvironmentId !== null &&
    uploadableAttachments().some((attachment) => {
      const upload = readAttachmentUpload(attachment.id);
      return upload?.status !== "ready" || upload.environmentId !== uploadEnvironmentId;
    });
  if (countPreparingComposerImages(targetKey) === 0 && !needsUpload) return null;
  if (heldSends.has(targetKey)) return Promise.resolve({ status: "cancelled" });
  return new Promise((resolve) => {
    let draft = useComposerDraftStore.getState().getComposerDraft(draftTarget);
    const settle = (result: HeldComposerSendResult) => {
      if (heldSends.get(targetKey) !== settle) return;
      heldSends.delete(targetKey);
      stopWatchingImages();
      stopWatchingDraft();
      useHeldSendStore.setState((state) => {
        const targetKeys = { ...state.targetKeys };
        delete targetKeys[targetKey];
        return { targetKeys };
      });
      resolve(result);
    };
    heldSends.set(targetKey, settle);
    const onImagesReady = (waitMicrotask: boolean) => {
      stopWatchingImages();
      const continueAfterImages = () => {
        if (heldSends.get(targetKey) !== settle) return;
        if (uploadEnvironmentId === null) {
          settle({ status: "ready" });
          return;
        }
        const attachments = uploadableAttachments();
        if (attachments.length === 0) {
          settle({ status: "ready" });
          return;
        }
        for (const attachment of attachments) {
          const upload = readAttachmentUpload(attachment.id);
          if (upload?.status === "ready" && upload.environmentId === uploadEnvironmentId) {
            continue;
          }
          const start = upload?.status === "failed" ? retryAttachmentUpload : startAttachmentUpload;
          start({ environmentId: uploadEnvironmentId, image: attachment, draftTarget });
        }
        void awaitAttachmentUploads(attachments.map((attachment) => attachment.id)).then(() => {
          if (heldSends.get(targetKey) !== settle) return;
          for (const attachment of attachments) {
            const upload = readAttachmentUpload(attachment.id);
            if (upload?.status === "ready" && upload.environmentId === uploadEnvironmentId) {
              continue;
            }
            const reason =
              upload?.status === "failed"
                ? attachmentUploadFailureText(upload, m)
                : m(msg("Attachment ''{name}'' failed to upload.", { name: attachment.name }));
            settle({ status: "upload-failed", reason });
            return;
          }
          settle({ status: "ready" });
        });
      };
      if (waitMicrotask) {
        // Let joinPreparedImagesToDraft finish inserting compressed images in this tick first.
        queueMicrotask(continueAfterImages);
      } else {
        continueAfterImages();
      }
    };
    const stopWatchingImages = usePreparingComposerImageStore.subscribe((state) => {
      if (!state.byTargetKey[targetKey]) onImagesReady(true);
    });
    const stopWatchingDraft = useComposerDraftStore.subscribe((state) => {
      const next = state.getComposerDraft(draftTarget);
      if (!preparedImagesJoiningDraft && composerDraftContentChanged(draft, next)) {
        settle({ status: "cancelled" });
      }
      draft = next;
    });
    useHeldSendStore.setState((state) => ({
      targetKeys: { ...state.targetKeys, [targetKey]: true },
    }));
    if (countPreparingComposerImages(targetKey) === 0) onImagesReady(false);
  });
}

/** Drops every image still preparing for the target, so its compression result is discarded. */
export function cancelPreparingComposerImages(targetKey: string): void {
  invalidatePendingSubmit(targetKey);
  if (!usePreparingComposerImageStore.getState().byTargetKey[targetKey]) return;
  usePreparingComposerImageStore.setState((state) => {
    const byTargetKey = { ...state.byTargetKey };
    delete byTargetKey[targetKey];
    return { byTargetKey };
  });
}

/**
 * Holds a send made while the target still has images compressing, and runs it once they finish,
 * so the turn includes them. Returns false when nothing is compressing and the caller should send.
 */
export function useSubmitAfterPreparingImages(targetKey: string, blocked = false) {
  const preparing = usePreparingComposerImages(targetKey);
  const pendingRef = useRef<{
    readonly targetKey: string;
    readonly cancelGeneration: number;
    readonly submit: () => void;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends only after the render where the compressed images joined the draft
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (
      pending.targetKey !== targetKey ||
      pending.cancelGeneration !== (cancelGenerations.get(targetKey) ?? 0)
    ) {
      pendingRef.current = null;
      return;
    }
    if (preparing.length > 0 || blocked) return;
    pendingRef.current = null;
    // After the composer's later effects have synced its draft refs to this render.
    queueMicrotask(pending.submit);
  }, [preparing, targetKey, blocked]);
  return useStableCallback((submit: () => void) => {
    if (countPreparingComposerImages(targetKey) === 0) return false;
    pendingRef.current = {
      targetKey,
      cancelGeneration: cancelGenerations.get(targetKey) ?? 0,
      submit,
    };
    return true;
  });
}
