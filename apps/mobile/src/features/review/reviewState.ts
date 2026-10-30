import { useAtomValue } from "@effect/atom-react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { clearReviewCommentTarget } from "./reviewCommentSelection";
import { buildReviewParsedDiff, type ReviewParsedDiff } from "./reviewModel";

const EMPTY_REVIEW_SECTION_FILE_IDS = Object.freeze<
  Readonly<Record<string, ReadonlyArray<string> | undefined>>
>({});
const EMPTY_REVIEW_SELECTED_SECTION_ID_ATOM = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:selected-section-id:null"),
);
const EMPTY_REVIEW_SECTION_FILE_IDS_ATOM = Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:section-file-ids:null"),
);

const reviewSelectedSectionIdByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make<string | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:selected-section-id:${threadKey}`),
  ),
);

const reviewExpandedFileIdsByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:expanded-file-ids:${threadKey}`),
  ),
);

const reviewRevealedLargeFileIdsByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:revealed-large-file-ids:${threadKey}`),
  ),
);

const reviewViewedFileIdsByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:viewed-file-ids:${threadKey}`),
  ),
);

export const MAX_CACHED_REVIEW_DIFFS = 8;
// This bounds source string length, not the parsed or native heap size.
export const MAX_CACHED_REVIEW_SOURCE_CHARACTERS = 4 * 1024 * 1024;

interface CachedReviewParsedDiff {
  readonly diff: string | null;
  readonly parsed: ReviewParsedDiff;
  readonly sourceCharacterCount: number;
}

const reviewParsedDiffCacheAtom = Atom.make(() => ({
  entries: new Map<string, CachedReviewParsedDiff>(),
  sourceCharacterCount: 0,
})).pipe(Atom.keepAlive, Atom.withLabel("mobile:review:parsed-diffs"));

export interface ReviewCacheForThread {
  readonly threadKey: string | null;
  readonly selectedSectionId: string | null;
  readonly expandedFileIdsBySection: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
  readonly revealedLargeFileIdsBySection: Readonly<
    Record<string, ReadonlyArray<string> | undefined>
  >;
  readonly viewedFileIdsBySection: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}

function buildThreadKey(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}): string | null {
  return input.environmentId && input.threadId
    ? scopedThreadKey(input.environmentId, input.threadId)
    : null;
}

function buildSectionCacheKey(threadKey: string, sectionId: string): string {
  return `${threadKey}:${sectionId}`;
}

export function useReviewCacheForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}): ReviewCacheForThread {
  const threadKey = buildThreadKey(input);
  const selectedSectionId = useAtomValue(
    threadKey
      ? reviewSelectedSectionIdByThreadKeyAtom(threadKey)
      : EMPTY_REVIEW_SELECTED_SECTION_ID_ATOM,
  );
  const expandedFileIdsBySection = useAtomValue(
    threadKey
      ? reviewExpandedFileIdsByThreadKeyAtom(threadKey)
      : EMPTY_REVIEW_SECTION_FILE_IDS_ATOM,
  );
  const revealedLargeFileIdsBySection = useAtomValue(
    threadKey
      ? reviewRevealedLargeFileIdsByThreadKeyAtom(threadKey)
      : EMPTY_REVIEW_SECTION_FILE_IDS_ATOM,
  );
  const viewedFileIdsBySection = useAtomValue(
    threadKey ? reviewViewedFileIdsByThreadKeyAtom(threadKey) : EMPTY_REVIEW_SECTION_FILE_IDS_ATOM,
  );

  return {
    threadKey,
    selectedSectionId,
    expandedFileIdsBySection,
    revealedLargeFileIdsBySection,
    viewedFileIdsBySection,
  };
}

export function setReviewSelectedSectionId(threadKey: string, sectionId: string | null): void {
  // A line selection belongs to the section it was made in; switching away drops it, so
  // switching back does not bring back a range over lines that may have changed.
  clearReviewCommentTarget();
  appAtomRegistry.set(reviewSelectedSectionIdByThreadKeyAtom(threadKey), sectionId);
}

export function updateReviewExpandedFileIds(
  threadKey: string,
  sectionId: string,
  update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
): void {
  const atom = reviewExpandedFileIdsByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  const nextValue = update(current[sectionId]);
  appAtomRegistry.set(atom, {
    ...current,
    [sectionId]: nextValue,
  });
}

export function updateReviewViewedFileIds(
  threadKey: string,
  sectionId: string,
  update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
): void {
  const atom = reviewViewedFileIdsByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  const nextValue = update(current[sectionId]);
  appAtomRegistry.set(atom, {
    ...current,
    [sectionId]: nextValue,
  });
}

export function getReviewParsedDiffSourceCharacterCount(input: {
  readonly threadKey: string;
  readonly sectionId: string;
  readonly diff: string | null;
}): number {
  const sourceCharacterCount = input.diff?.length ?? 0;
  const cache = appAtomRegistry.get(reviewParsedDiffCacheAtom);
  const cached = cache.entries.get(buildSectionCacheKey(input.threadKey, input.sectionId));
  return cached && cached.diff === (input.diff?.trim() ?? null)
    ? Math.max(sourceCharacterCount, cached.sourceCharacterCount)
    : sourceCharacterCount;
}

export function getCachedReviewParsedDiff(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly diff: string | null | undefined;
}): ReviewParsedDiff {
  if (!input.threadKey || !input.sectionId) {
    return buildReviewParsedDiff(input.diff, input.sectionId ?? "mobile-review");
  }

  const cacheKey = buildSectionCacheKey(input.threadKey, input.sectionId);
  const normalizedDiff = input.diff?.trim() ?? null;
  const cache = appAtomRegistry.get(reviewParsedDiffCacheAtom);
  const cached = cache.entries.get(cacheKey);
  if (cached && cached.diff === normalizedDiff) {
    cache.entries.delete(cacheKey);
    cache.entries.set(cacheKey, cached);
    return cached.parsed;
  }

  const parsed = buildReviewParsedDiff(input.diff, input.sectionId);
  if (cached) {
    cache.entries.delete(cacheKey);
    cache.sourceCharacterCount -= cached.sourceCharacterCount;
  }
  const sourceCharacterCount = input.diff?.length ?? 0;
  if (sourceCharacterCount > MAX_CACHED_REVIEW_SOURCE_CHARACTERS) {
    return parsed;
  }

  for (const [oldestKey, oldest] of cache.entries) {
    if (
      cache.entries.size < MAX_CACHED_REVIEW_DIFFS &&
      cache.sourceCharacterCount + sourceCharacterCount <= MAX_CACHED_REVIEW_SOURCE_CHARACTERS
    ) {
      break;
    }
    cache.entries.delete(oldestKey);
    cache.sourceCharacterCount -= oldest.sourceCharacterCount;
  }
  cache.entries.set(cacheKey, {
    diff: normalizedDiff,
    parsed,
    sourceCharacterCount,
  });
  cache.sourceCharacterCount += sourceCharacterCount;
  return parsed;
}
