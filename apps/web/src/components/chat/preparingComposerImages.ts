import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import {
  composerDraftHasUserContent,
  composerTargetKey,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
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
  | { readonly status: "cancelled" };

const heldSends = new Map<string, (result: HeldComposerSendResult) => void>();
const useHeldSendStore = create<{ readonly targetKeys: Readonly<Record<string, true>> }>(() => ({
  targetKeys: {},
}));
let preparedImagesJoiningDraft = false;

function invalidatePendingSubmit(targetKey: string) {
  cancelGenerations.set(targetKey, (cancelGenerations.get(targetKey) ?? 0) + 1);
  heldSends.get(targetKey)?.({ status: "cancelled" });
}

/** Whether a send from the target's draft is waiting on its images to finish preparing. */
export function useComposerSendHeld(targetKey: string): boolean {
  return useHeldSendStore((state) => state.targetKeys[targetKey] === true);
}

export function cancelHeldComposerSend(targetKey: string): void {
  heldSends.get(targetKey)?.({ status: "cancelled" });
}

/** Inserts finished images into the draft without counting as an edit to a held send. */
export function joinPreparedImagesToDraft<T>(insert: () => T): T {
  preparedImagesJoiningDraft = true;
  try {
    return insert();
  } finally {
    preparedImagesJoiningDraft = false;
  }
}

function composerSendSettingsChanged(
  before: ComposerThreadDraftState | null,
  after: ComposerThreadDraftState | null,
): boolean {
  const modelsChanged =
    before && after
      ? !Equal.equals(before.modelSelectionByProvider, after.modelSelectionByProvider)
      : Object.keys((before ?? after)?.modelSelectionByProvider ?? {}).length > 0;
  return (
    modelsChanged ||
    (before?.activeProvider ?? null) !== (after?.activeProvider ?? null) ||
    (before?.runtimeMode ?? null) !== (after?.runtimeMode ?? null) ||
    (before?.interactionMode ?? null) !== (after?.interactionMode ?? null)
  );
}

/** Watches for edits and attachment invalidation while a send waits for routing. */
export function watchComposerSendEdits(
  draftTarget: ComposerThreadTarget,
): () => "ready" | "edited" | "attachments-cancelled" {
  const targetKey = composerTargetKey(draftTarget);
  const submittedImages = new Set(getPreparingComposerImages(targetKey));
  const cancelGeneration = cancelGenerations.get(targetKey);
  let draft = useComposerDraftStore.getState().getComposerDraft(draftTarget);
  let changed = false;
  const stopWatchingDraft = useComposerDraftStore.subscribe((state) => {
    const next = state.getComposerDraft(draftTarget);
    if (!preparedImagesJoiningDraft) {
      changed ||=
        composerSendSettingsChanged(draft, next) ||
        (draft && next
          ? composerDraftContentChanged(draft, next)
          : composerDraftHasUserContent(draft ?? next));
    }
    draft = next;
  });
  const stopWatchingImages = usePreparingComposerImageStore.subscribe(() => {
    if (getPreparingComposerImages(targetKey).some((image) => !submittedImages.has(image))) {
      changed = true;
    }
  });
  return () => {
    stopWatchingDraft();
    stopWatchingImages();
    if (cancelGenerations.get(targetKey) !== cancelGeneration) return "attachments-cancelled";
    return changed ? "edited" : "ready";
  };
}

/**
 * Holds a send made while the draft still has images compressing. Resolves ready once they join
 * the draft, or cancelled if the draft is edited or the send cancelled. Null means nothing needs
 * to wait. Lives outside the composer so leaving the thread still completes the send.
 */
export function holdComposerSend(
  draftTarget: ComposerThreadTarget,
): Promise<HeldComposerSendResult> | null {
  const targetKey = composerTargetKey(draftTarget);
  if (countPreparingComposerImages(targetKey) === 0) return null;
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
    const stopWatchingImages = usePreparingComposerImageStore.subscribe((state) => {
      if (state.byTargetKey[targetKey]) return;
      // Let joinPreparedImagesToDraft finish inserting compressed images in this tick first.
      queueMicrotask(() => settle({ status: "ready" }));
    });
    const stopWatchingDraft = useComposerDraftStore.subscribe((state) => {
      const next = state.getComposerDraft(draftTarget);
      if (
        !preparedImagesJoiningDraft &&
        (composerDraftContentChanged(draft, next) || composerSendSettingsChanged(draft, next))
      ) {
        settle({ status: "cancelled" });
      }
      draft = next;
    });
    useHeldSendStore.setState((state) => ({
      targetKeys: { ...state.targetKeys, [targetKey]: true },
    }));
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
