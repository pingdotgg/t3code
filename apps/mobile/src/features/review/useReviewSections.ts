import { useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { Atom } from "effect/reactivity";

import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, ReviewDiffPreviewSource, ThreadId } from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { lastReviewGitSectionsAtom, reviewEnvironment } from "../../state/review";
import { lastReviewTurnDiffsAtom } from "../../state/reviewTurnDiffs";
import { environmentSession } from "../../state/session";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadRepositories } from "../../state/use-thread-repositories";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  buildReviewSectionItems,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
  resolveReviewSelectedSectionId,
  reviewTurnDiffsBySectionId,
  type ReviewSectionItem,
} from "./reviewModel";
import {
  checkpointsForReviewRepository,
  moveReviewSectionId,
  resolveReviewRepository,
  reviewRepositoriesFromWorkspace,
  reviewRepositorySectionPrefix,
  turnDiffForReviewRepository,
  withOutsideReviewRepository,
  type ReviewRepository,
  type ReviewTurnDiff,
} from "./reviewRepositories";
import { setReviewSelectedSectionId, type ReviewCacheForThread } from "./reviewState";

const NO_GIT_SECTIONS_ATOM = Atom.make<ReadonlyArray<ReviewDiffPreviewSource>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:git-sections:null"),
);
const NO_TURN_DIFFS_ATOM = Atom.make<Readonly<Record<number, ReviewTurnDiff>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:turn-diffs:null"),
);

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
  /** A repo the agent edited outside the thread, opened from its turn notice. */
  readonly outsideRepository?: { readonly name: string; readonly root: string } | null;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const threadRepositories = useSelectedThreadRepositories();
  // A multi-repo thread waits for its repo list, so no diff runs in a cwd it will not show.
  const enabled = (input.enabled ?? true) && !threadRepositories.loading;
  const fileAccessSession = useEnvironmentQuery(
    environmentId === undefined ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const repositories = withOutsideReviewRepository(
    reviewRepositoriesFromWorkspace(threadRepositories.repositories),
    input.outsideRepository ?? null,
  );
  // Single-repo threads list no repos and keep reviewing the thread's cwd.
  const repository = resolveReviewRepository(repositories, reviewCache.selectedSectionId);
  const cwd = repository?.cwd ?? selectedThreadCwd;
  const idPrefix = reviewRepositorySectionPrefix(repository);
  const titleSuffix = repositories.length > 1 && repository ? ` · ${repository.name}` : "";
  const diffPreview = useEnvironmentQuery(
    canReadFiles && enabled && environmentId !== undefined && cwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd },
        })
      : null,
  );
  const lastGitSections = useAtomValue(
    environmentId !== undefined && cwd !== null
      ? lastReviewGitSectionsAtom(environmentId, cwd)
      : NO_GIT_SECTIONS_ATOM,
  );

  const lastTurnDiffs = useAtomValue(
    environmentId !== undefined && threadId !== undefined
      ? lastReviewTurnDiffsAtom(environmentId, threadId)
      : NO_TURN_DIFFS_ATOM,
  );

  const sectionIdForCheckpoint = (checkpoint: { readonly checkpointTurnCount: number }) =>
    `${idPrefix}${getReviewSectionIdForCheckpoint(checkpoint)}`;
  const readyCheckpoints = getReadyReviewCheckpoints(
    checkpointsForReviewRepository(
      selectedThread === null ? [] : deriveThreadCheckpointSummaries(selectedThread.projection),
      repository,
    ),
  );
  const checkpointBySectionId = new Map(
    readyCheckpoints.map((checkpoint) => [sectionIdForCheckpoint(checkpoint), checkpoint]),
  );
  // Turns show their last answered diff; the active turn's live query below overrides it.
  // Section ids and the selection do not depend on the live query, so they are resolved first.
  const cachedSections = buildReviewSectionItems({
    checkpoints: readyCheckpoints,
    gitSections:
      canReadFiles || fileAccess.isPending ? (diffPreview.data?.sources ?? lastGitSections) : [],
    turnDiffById: reviewTurnDiffsBySectionId(readyCheckpoints, lastTurnDiffs, repository),
    loadingGitSections: fileAccess.isPending || diffPreview.isPending || threadRepositories.loading,
    idPrefix,
    titleSuffix,
  });
  const selectedSectionId = resolveReviewSelectedSectionId(
    cachedSections,
    reviewCache.selectedSectionId,
  );

  const selectedCheckpoint =
    selectedSectionId === null ? undefined : checkpointBySectionId.get(selectedSectionId);
  const activeCheckpoint = selectedCheckpoint ?? readyCheckpoints[0] ?? null;
  const activeSectionId = activeCheckpoint ? sectionIdForCheckpoint(activeCheckpoint) : null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && activeCheckpoint ? Math.max(0, activeCheckpoint.checkpointTurnCount - 1) : null,
    toTurnCount: enabled ? (activeCheckpoint?.checkpointTurnCount ?? null) : null,
    ignoreWhitespace: false,
  });

  const reviewSections = cachedSections.map((section): ReviewSectionItem => {
    if (section.kind === "turn") {
      return section.id === activeSectionId
        ? {
            ...section,
            diff: turnDiffForReviewRepository(activeTurnDiff.data, repository) ?? section.diff,
            isLoading: activeTurnDiff.isPending,
          }
        : section;
    }
    // Keep the selected section while its grant loads, without displaying cached host files.
    return fileAccess.isPending ? { ...section, diff: null, isLoading: true } : section;
  });
  const selectedSection =
    reviewSections.find((section) => section.id === selectedSectionId) ?? null;

  const refreshSelectedSection = async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    diffPreview.refresh();
  };

  const selectSection = (sectionId: string) => {
    if (reviewCache.threadKey) {
      setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
    }
  };

  const selectRepository = (next: ReviewRepository) => {
    if (reviewCache.threadKey && next.cwd !== repository?.cwd) {
      setReviewSelectedSectionId(
        reviewCache.threadKey,
        moveReviewSectionId(selectedSectionId, repository, next),
      );
    }
  };

  return {
    error:
      diffPreview.error ??
      activeTurnDiff.error ??
      (selectedSection === null && !fileAccess.isPending && !canReadFiles
        ? (fileAccess.error ?? "This connection cannot read local diffs.")
        : null),
    isSelectedSectionPending:
      selectedSection?.kind === "turn" ? activeTurnDiff.isPending : diffPreview.isPending,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
    /** Empty for single-repo threads. */
    repositories,
    repository,
    cwd,
    selectRepository,
  };
}
