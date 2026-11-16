import { create } from "zustand";

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
  /** Counts images per target that failed to compress, so a held send can tell one failed. */
  readonly failuresByTargetKey: Readonly<Record<string, number>>;
}>(() => ({ byTargetKey: {}, failuresByTargetKey: {} }));

export function usePreparingComposerImages(targetKey: string) {
  return usePreparingComposerImageStore(
    (state) => state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES,
  );
}

export function usePreparingComposerImageFailures(targetKey: string): number {
  return usePreparingComposerImageStore((state) => state.failuresByTargetKey[targetKey] ?? 0);
}

/** Records that an image for the target failed to compress. Call before removing it. */
export function recordPreparingComposerImageFailure(targetKey: string): void {
  usePreparingComposerImageStore.setState((state) => ({
    failuresByTargetKey: {
      ...state.failuresByTargetKey,
      [targetKey]: (state.failuresByTargetKey[targetKey] ?? 0) + 1,
    },
  }));
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
): ReadonlySet<string> {
  const current =
    usePreparingComposerImageStore.getState().byTargetKey[targetKey] ?? NO_PREPARING_IMAGES;
  const removed = new Set(
    current.filter((image) => imageIds.has(image.id)).map((image) => image.id),
  );
  if (removed.size === 0) return removed;
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

/** Drops every image still preparing for the target, so its compression result is discarded. */
export function cancelPreparingComposerImages(targetKey: string): void {
  if (!usePreparingComposerImageStore.getState().byTargetKey[targetKey]) return;
  usePreparingComposerImageStore.setState((state) => {
    const byTargetKey = { ...state.byTargetKey };
    delete byTargetKey[targetKey];
    return { byTargetKey };
  });
}
