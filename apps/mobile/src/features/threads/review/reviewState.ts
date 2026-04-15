import { useAtomValue } from "@effect/atom-react";

import { EnvironmentId, ThreadId, type GitReviewDiffSection } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { scopedThreadKey } from "../../../lib/scopedEntities";
import { appAtomRegistry } from "../../../state/atom-registry";
import { buildReviewParsedDiff, type ReviewParsedDiff } from "./reviewModel";

const EMPTY_GIT_REVIEW_SECTIONS = Object.freeze<ReadonlyArray<GitReviewDiffSection>>([]);
const EMPTY_REVIEW_TURN_DIFFS = Object.freeze<Readonly<Record<string, string>>>({});
const EMPTY_REVIEW_SECTION_FILE_IDS = Object.freeze<
  Readonly<Record<string, ReadonlyArray<string> | undefined>>
>({});
const EMPTY_REVIEW_GIT_SECTIONS_ATOM = Atom.make(EMPTY_GIT_REVIEW_SECTIONS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:git-sections:null"),
);
const EMPTY_REVIEW_TURN_DIFFS_ATOM = Atom.make(EMPTY_REVIEW_TURN_DIFFS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:turn-diffs:null"),
);
const EMPTY_REVIEW_SELECTED_SECTION_ID_ATOM = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:selected-section-id:null"),
);
const EMPTY_REVIEW_SECTION_FILE_IDS_ATOM = Atom.make(EMPTY_REVIEW_SECTION_FILE_IDS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:section-file-ids:null"),
);

const reviewGitSectionsByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_GIT_REVIEW_SECTIONS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:git-sections:${threadKey}`),
  ),
);

const reviewTurnDiffByThreadKeyAtom = Atom.family((threadKey: string) =>
  Atom.make(EMPTY_REVIEW_TURN_DIFFS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:turn-diffs:${threadKey}`),
  ),
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

const reviewParsedDiffBySectionCacheKeyAtom = Atom.family((cacheKey: string) =>
  Atom.make<{ readonly diff: string | null; readonly parsed: ReviewParsedDiff } | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:parsed-diffs:${cacheKey}`),
  ),
);

function buildThreadKey(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
}): string | null {
  return input.environmentId && input.threadId
    ? scopedThreadKey(EnvironmentId.make(input.environmentId), ThreadId.make(input.threadId))
    : null;
}

function buildSectionCacheKey(threadKey: string, sectionId: string): string {
  return `${threadKey}:${sectionId}`;
}

export function useReviewCacheForThread(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
}) {
  const threadKey = buildThreadKey(input);
  const gitSections = useAtomValue(
    threadKey ? reviewGitSectionsByThreadKeyAtom(threadKey) : EMPTY_REVIEW_GIT_SECTIONS_ATOM,
  );
  const turnDiffById = useAtomValue(
    threadKey ? reviewTurnDiffByThreadKeyAtom(threadKey) : EMPTY_REVIEW_TURN_DIFFS_ATOM,
  );
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

  return {
    threadKey,
    gitSections,
    turnDiffById,
    selectedSectionId,
    expandedFileIdsBySection,
    revealedLargeFileIdsBySection,
  };
}

export function setReviewGitSections(
  threadKey: string,
  sections: ReadonlyArray<GitReviewDiffSection>,
): void {
  appAtomRegistry.set(reviewGitSectionsByThreadKeyAtom(threadKey), sections);
}

export function setReviewTurnDiff(threadKey: string, sectionId: string, diff: string): void {
  const atom = reviewTurnDiffByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  appAtomRegistry.set(atom, {
    ...current,
    [sectionId]: diff,
  });
}

export function setReviewSelectedSectionId(threadKey: string, sectionId: string | null): void {
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

export function updateReviewRevealedLargeFileIds(
  threadKey: string,
  sectionId: string,
  update: (current: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
): void {
  const atom = reviewRevealedLargeFileIdsByThreadKeyAtom(threadKey);
  const current = appAtomRegistry.get(atom);
  const nextValue = update(current[sectionId]);
  appAtomRegistry.set(atom, {
    ...current,
    [sectionId]: nextValue,
  });
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
  const atom = reviewParsedDiffBySectionCacheKeyAtom(cacheKey);
  const cached = appAtomRegistry.get(atom);
  if (cached && cached.diff === normalizedDiff) {
    return cached.parsed;
  }

  const parsed = buildReviewParsedDiff(input.diff, input.sectionId);
  appAtomRegistry.set(atom, {
    diff: normalizedDiff,
    parsed,
  });
  return parsed;
}
