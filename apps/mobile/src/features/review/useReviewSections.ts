import { useAtomValue } from "@effect/atom-react";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { msg, useMessages } from "gt-react-native";

import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, ReviewDiffPreviewSource, ThreadId } from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { lastReviewGitSectionsAtom, reviewEnvironment } from "../../state/review";
import { lastReviewTurnDiffsAtom, reviewTurnDiffText } from "../../state/reviewTurnDiffs";
import { environmentSession } from "../../state/session";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import {
  buildReviewSectionItems,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
  resolveReviewSelectedSectionId,
  reviewTurnDiffsBySectionId,
  type ReviewGitSectionKind,
  type ReviewSectionItem,
} from "./reviewModel";
import { setReviewSelectedSectionId, type ReviewCacheForThread } from "./reviewState";

const NO_GIT_SECTIONS_ATOM = Atom.make<ReadonlyArray<ReviewDiffPreviewSource>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:git-sections:null"),
);
const NO_TURN_DIFFS_ATOM = Atom.make<Readonly<Record<number, string>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:turn-diffs:null"),
);

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const messages = useMessages();
  const enabled = input.enabled ?? true;
  const fileAccessSession = useEnvironmentQuery(
    environmentId === undefined ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: fileEnvironment.isReady,
      connection: fileEnvironment.presentation?.connection ?? null,
      session: fileAccessSession.data,
      sessionError: fileAccessSession.error,
    },
    messages,
  );
  const { canReadFiles } = fileAccess;
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const [repositoryChoice, setRepositoryChoice] = useState<{
    threadKey: string | null;
    cwd: string;
  } | null>(null);
  const repositoriesQuery = useEnvironmentQuery(
    canReadFiles && enabled && environmentId && selectedThreadCwd
      ? reviewEnvironment.repositories({ environmentId, input: { cwd: selectedThreadCwd } })
      : null,
  );
  const { selectedThreadProject } = useThreadSelection();
  const repositories = (repositoriesQuery.data?.repositories ?? []).map((repo) =>
    repo.path ? repo : { ...repo, name: selectedThreadProject?.title || repo.name },
  );
  const selectedRepository =
    repositories.find(
      (repo) =>
        repositoryChoice?.threadKey === reviewCache.threadKey && repo.cwd === repositoryChoice.cwd,
    ) ?? repositories[0];
  // A chosen child stays unresolved while discovery has no answer, so its review never shows the parent.
  const repositoryUnresolved =
    repositoryChoice?.threadKey === reviewCache.threadKey &&
    repositoryChoice.cwd !== selectedThreadCwd &&
    !repositoriesQuery.data;
  const reviewCwd = repositoryUnresolved
    ? null
    : selectedRepository?.path
      ? selectedRepository.cwd
      : selectedThreadCwd;
  const repositoryPath = selectedRepository?.path ?? "";
  const diffPreviewQuery = (sourceKind: ReviewGitSectionKind) =>
    canReadFiles && enabled && environmentId !== undefined && reviewCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: reviewCwd, sourceKind },
        })
      : null;
  const workingTreePreview = useEnvironmentQuery(diffPreviewQuery("working-tree"));
  const branchPreview = useEnvironmentQuery(diffPreviewQuery("branch-range"));
  const lastGitSections = useAtomValue(
    environmentId !== undefined && reviewCwd !== null
      ? lastReviewGitSectionsAtom(environmentId, reviewCwd)
      : NO_GIT_SECTIONS_ATOM,
  );

  const gitSections = (
    [
      ["working-tree", workingTreePreview],
      ["branch-range", branchPreview],
    ] as const
  ).flatMap(([kind, preview]) =>
    (preview.data?.incomplete
      ? lastGitSections
      : (preview.data?.sources ?? lastGitSections)
    ).filter((source) => source.kind === kind),
  );

  const lastTurnDiffs = useAtomValue(
    environmentId !== undefined && threadId !== undefined
      ? lastReviewTurnDiffsAtom(environmentId, threadId)
      : NO_TURN_DIFFS_ATOM,
  );

  const readyCheckpoints = getReadyReviewCheckpoints(
    selectedThread === null ? [] : deriveThreadCheckpointSummaries(selectedThread.projection),
  );
  const checkpointBySectionId = new Map(
    readyCheckpoints.map((checkpoint) => [getReviewSectionIdForCheckpoint(checkpoint), checkpoint]),
  );
  // Turns show their last answered diff; the active turn's live query below overrides it.
  // Section ids and the selection do not depend on the live query, so they are resolved first.
  const cachedSections = buildReviewSectionItems({
    checkpoints: readyCheckpoints,
    gitSections: canReadFiles || fileAccess.isPending ? gitSections : [],
    turnDiffById: reviewTurnDiffsBySectionId(readyCheckpoints, lastTurnDiffs),
    repositoryPath,
    gitSectionStates: {
      "working-tree": gitSectionState(fileAccess.isPending, workingTreePreview),
      "branch-range": gitSectionState(fileAccess.isPending, branchPreview),
    },
    ...(selectedThreadProject ? { rootName: selectedThreadProject.title } : {}),
    resolve: messages,
  });
  const selectedSectionId = resolveReviewSelectedSectionId(
    cachedSections,
    reviewCache.selectedSectionId,
  );

  const selectedCheckpoint =
    selectedSectionId === null ? undefined : checkpointBySectionId.get(selectedSectionId);
  const activeCheckpoint = selectedCheckpoint ?? readyCheckpoints[0] ?? null;
  const activeSectionId = activeCheckpoint
    ? getReviewSectionIdForCheckpoint(activeCheckpoint)
    : null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && activeCheckpoint ? Math.max(0, activeCheckpoint.checkpointTurnCount - 1) : null,
    toTurnCount: enabled ? (activeCheckpoint?.checkpointTurnCount ?? null) : null,
    ignoreWhitespace: false,
  });
  const activeTurnDiffData = activeTurnDiff.data;
  const activeTurnDiffText = useMemo(
    () => (activeTurnDiffData == null ? null : reviewTurnDiffText(activeTurnDiffData)),
    [activeTurnDiffData],
  );

  const reviewSections = cachedSections.map((section): ReviewSectionItem => {
    if (section.kind === "turn") {
      return section.id === activeSectionId
        ? {
            ...section,
            diff: activeTurnDiffText ?? section.diff,
            isLoading: activeTurnDiff.isPending,
          }
        : section;
    }
    // Keep the selected section while its grant loads, without displaying cached host files.
    return fileAccess.isPending ? { ...section, diff: null, isLoading: true } : section;
  });
  const selectedSection =
    reviewSections.find((section) => section.id === selectedSectionId) ?? null;

  // With a child unresolved there are no Git sections, so a turn can be selected only as a fallback.
  const repositoryFailureVisible =
    repositoryUnresolved &&
    !(selectedSection?.kind === "turn" && reviewCache.selectedSectionId === selectedSection.id);
  const selectedGitPreview =
    selectedSection?.kind === "working-tree"
      ? workingTreePreview
      : selectedSection?.kind === "branch-range"
        ? branchPreview
        : null;

  const refreshSelectedSection = async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      if (!repositoryFailureVisible) return;
    }
    repositoriesQuery.refresh();
    if (selectedGitPreview) {
      selectedGitPreview.refresh();
    } else {
      workingTreePreview.refresh();
      branchPreview.refresh();
    }
  };

  const selectSection = (sectionId: string) => {
    if (reviewCache.threadKey) {
      setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
    }
  };

  const selectRepository = (cwd: string) => {
    if (!repositories.some((repo) => repo.cwd === cwd)) return;
    if (selectedRepository?.cwd === cwd) return;
    setRepositoryChoice({ threadKey: reviewCache.threadKey, cwd });
    if (reviewCache.threadKey) setReviewSelectedSectionId(reviewCache.threadKey, null);
  };

  return {
    repositories,
    selectedRepository,
    selectRepository,
    reviewCwd: selectedSection?.kind === "turn" ? selectedThreadCwd : reviewCwd,
    repositoryPath: selectedSection?.kind === "turn" ? "" : repositoryPath,
    error:
      (repositoryFailureVisible ? repositoriesQuery.error : null) ??
      (selectedSection?.kind === "turn"
        ? activeTurnDiff.error
        : (selectedGitPreview?.error ?? null)) ??
      (selectedSection === null && !fileAccess.isPending && !canReadFiles
        ? (fileAccess.error ?? messages(msg("This connection cannot read local diffs.")))
        : null),
    isSelectedSectionPending:
      (repositoryFailureVisible && repositoriesQuery.isPending) ||
      (selectedSection?.kind === "turn"
        ? activeTurnDiff.isPending
        : (selectedGitPreview?.isPending ?? false)),
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}

function gitSectionState(
  isFileAccessPending: boolean,
  preview: { readonly isPending: boolean; readonly error: string | null },
) {
  if (isFileAccessPending || preview.isPending) return "loading";
  return preview.error === null ? null : "failed";
}
