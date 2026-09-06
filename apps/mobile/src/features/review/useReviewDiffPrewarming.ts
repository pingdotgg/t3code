import { useEffect } from "react";

import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import type { ReviewSectionItem } from "./reviewModel";
import {
  getCachedReviewParsedDiff,
  getReviewParsedDiffSourceCharacterCount,
  MAX_CACHED_REVIEW_DIFFS,
  MAX_CACHED_REVIEW_SOURCE_CHARACTERS,
} from "./reviewState";

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type IdleCallback = (deadline: IdleDeadlineLike) => void;

function scheduleIdle(callback: IdleCallback): number {
  if (typeof globalThis.requestIdleCallback === "function") {
    return globalThis.requestIdleCallback(callback, { timeout: 2_000 });
  }

  return setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    100,
  ) as unknown as number;
}

function cancelIdle(handle: number): void {
  if (typeof globalThis.cancelIdleCallback === "function") {
    globalThis.cancelIdleCallback(handle);
    return;
  }
  clearTimeout(handle);
}

export function prewarmReviewDiffSection(input: {
  readonly threadKey: string;
  readonly section: ReviewSectionItem;
}): void {
  const { section, threadKey } = input;
  if (section.diff === null || section.diff.length > MAX_CACHED_REVIEW_SOURCE_CHARACTERS) {
    return;
  }

  const parsedDiff = getCachedReviewParsedDiff({
    threadKey,
    sectionId: section.id,
    diff: section.diff,
  });
  getCachedNativeReviewDiffData({ parsedDiff, comments: [] });
}

/** Selects nearby loaded sections that fit in the cache with the selected section. */
export function getReviewDiffPrewarmSections(input: {
  readonly threadKey: string;
  readonly sections: ReadonlyArray<ReviewSectionItem>;
  readonly selectedSectionId: string | null;
}): ReadonlyArray<ReviewSectionItem> {
  const { threadKey, sections, selectedSectionId } = input;
  const selectedIndex = sections.findIndex((section) => section.id === selectedSectionId);
  const selectedSection = sections[selectedIndex];
  if (!selectedSection) {
    return [];
  }

  let sourceCharacterCount = getReviewParsedDiffSourceCharacterCount({
    threadKey,
    sectionId: selectedSection.id,
    diff: selectedSection.diff,
  });
  if (sourceCharacterCount > MAX_CACHED_REVIEW_SOURCE_CHARACTERS) {
    return [];
  }

  const pendingSections: ReviewSectionItem[] = [];
  for (let distance = 1; distance < sections.length; distance += 1) {
    for (const index of [selectedIndex - distance, selectedIndex + distance]) {
      if (pendingSections.length >= MAX_CACHED_REVIEW_DIFFS - 1) {
        return pendingSections;
      }
      const section = sections[index];
      if (!section || section.diff === null) {
        continue;
      }
      const sectionCharacterCount = getReviewParsedDiffSourceCharacterCount({
        threadKey,
        sectionId: section.id,
        diff: section.diff,
      });
      if (sourceCharacterCount + sectionCharacterCount > MAX_CACHED_REVIEW_SOURCE_CHARACTERS) {
        continue;
      }
      pendingSections.push(section);
      sourceCharacterCount += sectionCharacterCount;
    }
  }
  return pendingSections;
}

/** Warms one nearby section per idle period, after navigation animations finish. */
export function useReviewDiffPrewarming(input: {
  readonly threadKey: string | null;
  readonly sections: ReadonlyArray<ReviewSectionItem>;
  readonly selectedSectionId: string | null;
}): void {
  const { sections, selectedSectionId, threadKey } = input;

  useEffect(() => {
    if (!threadKey) {
      return;
    }

    const pendingSections = getReviewDiffPrewarmSections({
      threadKey,
      sections,
      selectedSectionId,
    });
    if (pendingSections.length === 0) {
      return;
    }

    let cancelled = false;
    let idleHandle: number | null = null;
    let nextSectionIndex = 0;

    const scheduleNext = () => {
      idleHandle = scheduleIdle(() => {
        if (cancelled) {
          return;
        }

        const section = pendingSections[nextSectionIndex];
        if (!section) {
          return;
        }
        nextSectionIndex += 1;
        prewarmReviewDiffSection({ threadKey, section });

        if (nextSectionIndex < pendingSections.length) {
          scheduleNext();
        }
      });
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (idleHandle !== null) {
        cancelIdle(idleHandle);
      }
    };
  }, [sections, selectedSectionId, threadKey]);
}
