import type { CodeViewItem, SelectedLineRange } from "@pierre/diffs";
import type { CodeViewDiffItem } from "@pierre/diffs/react";
import type { PullRequestDiffSide } from "@t3tools/contracts";
import { ChevronDown, ChevronRight } from "lucide";
import { useAtomRefresh } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { use, useEffect, useRef, useState } from "react";

import { observeIntersection } from "~/lib/observeIntersection";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { areAllDiffFilesCollapsed } from "~/lib/diffCollapse";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { buildFileDiffRenderKey, fnv1a32, getDiffLineStat, resolveDiffThemeName, resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { createPullRequestDiffFileContentsLoader } from "~/lib/diffFileContents";
import { buildDiffReviewComment, resolveDiffReviewAnchor, type ReviewCommentContext } from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { useDiffWorkerPool } from "../DiffWorkerPoolProvider";
import { useCodeViewFileReveal } from "../diffs/useCodeViewFileReveal";
import { useHideTestFiles } from "../diffs/useHideTestFiles";
import { diffFileTreeEntries } from "../diffs/diffFileTree.logic";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { getReviewPositionAnchor, toViewerSide } from "./PullRequestReviewAnnotation";
import { getFileViewedRange, isFileDiffCollapsed, isLineInFileDiff, toggleFileDiffFoldForViewed, type DiffFoldOverride } from "./pullRequestDiff.logic";
import { PullRequestDiffStat } from "./pullRequestPresentation";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { pullRequestReviewKey, usePendingReviewComments, usePullRequestReviewStore } from "./pullRequestReviewStore";
import {
  COMMIT_PAGE_SIZE,
  DiffSlice,
  DraftAnchor,
  FileViewedToggle,
  MutableAnnotationGroup,
  NO_SLICES,
  PULL_REQUEST_FILE_TREE_STORAGE_KEY,
  ReviewAnnotation,
  ReviewAnnotationGroup,
  diffModel,
  reviewThreadsByPath,
  type PullRequestCodeTabProps,
} from "./pullRequestCodeTabShared";

export function usePullRequestCodeTabState(props: PullRequestCodeTabProps) {
  const {
  scrollerRef,
  environmentId,
  reference,
  detail,
  selectedCommitOid,
  onSelectedCommitChange,
  pendingFinding,
  fixFindingLabel = "Fix in a thread",
  onFixFinding,
  onAddToAgentSelection,
  onRefresh,
  refreshToken = 0,
  backgroundRefreshToken = 0,
  revealRequest = null,
  } = props;

  const resolvedTheme = useRenderedAppearance();
  // Initialize the shared tokenizer and workers while the diff request is still pending.
  useDiffWorkerPool();
  const settings = useClientSettings((settings) => ({
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    wordWrap: settings.wordWrap,
  }));
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [lastViewedFileKey, setLastViewedFileKey] = useState<string | null>(null);
  const [visibleCommitCount, setVisibleCommitCount] = useState(COMMIT_PAGE_SIZE);
  const [foldOverride, setFoldOverride] = useState<DiffFoldOverride>(null);
  const effectiveFoldOverride =
    foldOverride ?? (settings.diffFilesCollapsed ? "folded" : "expanded");
  const diffLayout = settings.diffLayout;
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    PULL_REQUEST_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<DraftAnchor | null>(null);
  const [threadPending, setThreadPending] = useState(false);
  const [orphansOpen, setOrphansOpen] = useState(false);
  // Scope slices before reset to prevent using a previous pull request's data or cursor.
  const [sliceState, setSliceState] = useState<{
    readonly key: string;
    readonly cursor: string | null;
    readonly slices: ReadonlyArray<DiffSlice>;
  }>({ key: "", cursor: null, slices: NO_SLICES });

  const referenceKey = pullRequestReviewKey(reference);
  // A commit opened from the timeline or left selected across a force-push may no longer be
  // part of the pull request; read it as "All commits" instead of requesting its diff.
  const commit =
    selectedCommitOid !== null && detail.commits.some((entry) => entry.oid === selectedCommitOid)
      ? selectedCommitOid
      : null;
  const scopeKey = JSON.stringify([environmentId, referenceKey, commit]);
  // The panel keeps this mounted across pull requests, so an open composer would otherwise
  // survive the switch and attach its comment to whichever one is on screen when it is sent.
  const [stateScopeKey, setStateScopeKey] = useState(scopeKey);
  if (stateScopeKey !== scopeKey) {
    setStateScopeKey(scopeKey);
    setLastViewedFileKey(null);
    setDraft(null);
    setSelectedLines(null);
    setToggledFiles(new Set());
    setFoldOverride(null);
    setVisibleCommitCount(COMMIT_PAGE_SIZE);
    setOrphansOpen(false);
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
  }

  const loadedSlices = sliceState.key === scopeKey ? sliceState.slices : NO_SLICES;
  const cursor = sliceState.key === scopeKey ? sliceState.cursor : null;
  const diffQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({
      environmentId,
      input: {
        ...reference,
        ...(cursor === null ? {} : { cursor }),
        ...(commit === null ? {} : { commit }),
      },
    }),
  );
  const [appliedPage, setAppliedPage] = useState<{
    readonly data: typeof diffQuery.data;
    readonly cursor: string | null;
    readonly scopeKey: string;
  } | null>(null);
  const data = diffQuery.data;
  if (
    data !== null &&
    (appliedPage?.data !== data ||
      appliedPage.cursor !== cursor ||
      appliedPage.scopeKey !== scopeKey)
  ) {
    setAppliedPage({ data, cursor, scopeKey });
    setSliceState((previous) => {
      const slices = previous.key === scopeKey ? previous.slices : NO_SLICES;
      const next = {
        source: data,
        cursor,
        patch: data.patch,
        truncated: data.truncated,
        nextCursor: data.nextCursor,
        omittedFileStats: data.omittedFileStats ?? [],
      };
      const index = slices.findIndex((slice) => slice.cursor === cursor);
      if (index === -1) {
        return { key: scopeKey, cursor, slices: [...slices, next] };
      }
      const existing = slices[index];
      if (
        existing !== undefined &&
        existing.patch === next.patch &&
        existing.truncated === next.truncated &&
        existing.nextCursor === next.nextCursor &&
        existing.omittedFileStats.length === next.omittedFileStats.length &&
        existing.omittedFileStats.every((file, index) => {
          const refreshed = next.omittedFileStats[index];
          return (
            refreshed !== undefined &&
            refreshed.path === file.path &&
            refreshed.additions === file.additions &&
            refreshed.deletions === file.deletions
          );
        })
      ) {
        return previous;
      }
      // Drop later slices when replacing a changed page; their cursors target the old diff.
      return { key: scopeKey, cursor, slices: [...slices.slice(0, index), next] };
    });
  }
  const refreshFirstDiffPage = useAtomRefresh(
    pullRequestEnvironment.diff({
      environmentId,
      input: { ...reference, ...(commit === null ? {} : { commit }) },
    }),
  );
  const reviewKey = referenceKey;
  const pendingComments = usePendingReviewComments(reference);
  const addComment = usePullRequestReviewStore((store) => store.addComment);
  const removeComment = usePullRequestReviewStore((store) => store.removeComment);
  const replyToThread = useAtomCommand(pullRequestEnvironment.replyToThread, {
    reportFailure: false,
  });
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });
  const loadThreadComments = useAtomCommand(pullRequestEnvironment.threadComments, {
    reportFailure: false,
  });
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents);

  const viewedFilesStore = detail.capabilities.viewedFiles;
  const filesViewed = usePullRequestFilesViewed({
    environmentId,
    reference,
    enabled: viewedFilesStore !== undefined,
  });
  const {
    setViewed,
    refresh: refreshFilesViewed,
    enabled: filesViewedEnabled,
    isViewed: isFileViewed,
    isStale: isFileViewedStale,
  } = filesViewed;
  const appliedRefreshToken = useRef(refreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new refresh token clears loaded slices and refetches the first diff page and viewed files
  useEffect(() => {
    if (appliedRefreshToken.current === refreshToken) return;
    appliedRefreshToken.current = refreshToken;
    setSliceState({ key: scopeKey, cursor: null, slices: NO_SLICES });
    // An equal refetch keeps the answer's identity, so the emptied slices refill only if the
    // applied page is forgotten too.
    setAppliedPage(null);
    refreshFirstDiffPage();
    refreshFilesViewed();
  }, [refreshToken, scopeKey, refreshFirstDiffPage, refreshFilesViewed]);
  const appliedBackgroundRefreshToken = useRef(backgroundRefreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a background refresh token refetches the first diff page and viewed files while keeping slices
  useEffect(() => {
    if (appliedBackgroundRefreshToken.current === backgroundRefreshToken) return;
    appliedBackgroundRefreshToken.current = backgroundRefreshToken;
    // Keeping slices mounted preserves scroll; the page merge invalidates changed pages.
    setSliceState((previous) => ({ ...previous, cursor: null }));
    refreshFirstDiffPage();
    refreshFilesViewed();
  }, [backgroundRefreshToken, refreshFirstDiffPage, refreshFilesViewed]);

  const codeViewReveal = useCodeViewFileReveal();
  const answeredRevealNonce = useRef<number | null>(null);
  const isRevealAnswered = (nonce: number): boolean => answeredRevealNonce.current === nonce;
  const markRevealAnswered = (nonce: number): void => {
    answeredRevealNonce.current = nonce;
  };

  const loadDiffFiles = createPullRequestDiffFileContentsLoader(getDiffFileContents, {
    environmentId,
    reference,
    commit,
    cacheKey: `pull-request:${referenceKey}:${detail.updatedAt}:${commit ?? "all"}`,
  });
  const hostReview = detail.capabilities.review;
  const review = {
    inlineComment: hostReview.inlineComment && detail.viewerPermissions.comment,
    reply: hostReview.reply && detail.viewerPermissions.comment,
    resolve: hostReview.resolve && detail.viewerPermissions.resolve,
  };
  const canCommentOnLines = review.inlineComment && commit === null;
  const rangeComments = hostReview.rangeComment === true;
  // Agent context is local, so it does not require host comment permission.
  const canSelectLines =
    commit === null && (review.inlineComment || onAddToAgentSelection !== undefined);
  const { parsedSlices, loadedFiles, sourceFileStats } = diffModel(
    loadedSlices,
    `pull-request:${scopeKey}:${resolvedTheme}:${ignoreWhitespace}`,
    ignoreWhitespace,
  );
  const testFileCount = loadedFiles.filter((file) =>
    isTestChangedFile(resolveFileDiffPath(file)),
  ).length;
  // A requested file stays visible so a jump to a hidden test still lands.
  const files = hideTestFiles
    ? loadedFiles.filter((file) => {
        const path = resolveFileDiffPath(file);
        return path === revealRequest?.path || !isTestChangedFile(path);
      })
    : loadedFiles;
  const hiddenTestFileCount = loadedFiles.length - files.length;
  const filePaths = files.map((file) => resolveFileDiffPath(file));
  const omittedFileStats = new Map(
    loadedSlices.flatMap((slice) =>
      slice.omittedFileStats.map((file) => [file.path, file] as const),
    ),
  );
  const fileTreeEntries = diffFileTreeEntries(files);
  const threadsByPath = reviewThreadsByPath(detail.reviewThreads);
  // File membership does not guarantee a rendered hunk for the thread.
  const placedThreadIds = (() => {
    const placed = new Set<string>();
    // Commit diffs use different line coordinates; list conversations separately.
    if (commit !== null) return placed;
    for (const file of files) {
      for (const thread of threadsByPath.get(resolveFileDiffPath(file)) ?? []) {
        if (thread.line !== null && isLineInFileDiff(file, thread.side, thread.line)) {
          placed.add(thread.id);
        }
      }
    }
    return placed;
  })();

  const annotatedFiles = files.map((fileDiff) => {
    const fileKey = buildFileDiffRenderKey(fileDiff);
    const path = resolveFileDiffPath(fileDiff);
    const groups = new Map<string, MutableAnnotationGroup>();
    const groupAt = (side: PullRequestDiffSide, line: number) => {
      const key = `${side}:${line}`;
      const existing = groups.get(key);
      if (existing) return existing;
      const created: MutableAnnotationGroup = {
        side,
        line,
        threads: [],
        pending: [],
        draft: false,
      };
      groups.set(key, created);
      return created;
    };

    for (const thread of threadsByPath.get(path) ?? []) {
      if (thread.line === null || !placedThreadIds.has(thread.id)) continue;
      groupAt(thread.side, thread.line).threads.push(thread);
    }
    if (commit === null) {
      for (const comment of pendingComments) {
        if (comment.path !== path) continue;
        const anchor = getReviewPositionAnchor(comment.position);
        groupAt(anchor.side, anchor.line).pending.push(comment);
      }
    }
    if (draft?.fileKey === fileKey) {
      const anchor = getReviewPositionAnchor(draft.position);
      groupAt(anchor.side, anchor.line).draft = true;
    }

    const annotations: ReviewAnnotation[] = [...groups.values()].map((group) => ({
      side: toViewerSide(group.side),
      lineNumber: group.line,
      metadata: { threads: group.threads, pending: group.pending, draft: group.draft },
    }));
    return {
      fileKey,
      path,
      fileDiff,
      annotations,
      // The viewer redraws annotations only when their version changes.
      annotationsVersion: fnv1a32(
        annotations
          .map(
            ({ side, lineNumber, metadata }) =>
              `${side}:${lineNumber}:${metadata.draft ? "d" : ""}:${metadata.pending
                .map((comment) => `${comment.id}:${comment.body}`)
                .join(",")}:${metadata.threads
                .map(
                  (thread) =>
                    `${thread.id}:${thread.isResolved ? "r" : ""}:${
                      thread.isOutdated ? "o" : ""
                    }:${thread.comments
                      .map(
                        (comment) =>
                          `${comment.id}:${comment.author?.login ?? ""}:${comment.createdAt}:${comment.body}:${(
                            comment.reactions ?? []
                          )
                            .map((r) => `${r.content}:${r.count}:${r.viewerHasReacted ? "v" : ""}`)
                            .join(",")}`,
                      )
                      .join(";")}`,
                )
                .join(",")}`,
          )
          .join("|"),
      ),
    };
  });

  const nextCursor = loadedSlices.at(-1)?.nextCursor ?? null;
  const withheldContent =
    loadedSlices.some((slice) => slice.truncated) ||
    parsedSlices.some((parsed) => parsed?.kind === "raw");
  // Keep the sentinel until all pages load; returning raw slices early would stop pagination.
  const rawSlices =
    nextCursor === null
      ? parsedSlices.flatMap((parsed) => (parsed?.kind === "raw" ? [parsed] : []))
      : [];
  const rawSlicesView =
    files.length === 0 && rawSlices.length > 0 ? (
      <div className="space-y-4 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    ) : null;
  const unstructured =
    rawSlices.length === 0 ? null : (
      <div className="space-y-4 border-t border-border/60 px-4 py-5">
        {rawSlices.map((slice) => (
          <div key={`${slice.reason}:${slice.text.slice(0, 64)}`} className="space-y-2">
            <p className="text-xs text-muted-foreground">{slice.reason}</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{slice.text}</pre>
          </div>
        ))}
      </div>
    );

  const items: CodeViewDiffItem<ReviewAnnotationGroup>[] = annotatedFiles.map(
    ({ fileKey, path, fileDiff, annotations, annotationsVersion }) => {
      const collapsed = isFileDiffCollapsed(fileKey, effectiveFoldOverride, toggledFiles);
      const viewedMark = filesViewedEnabled
        ? `e${isFileViewed(path) ? "v" : ""}${isFileViewedStale(path) ? "s" : ""}`
        : "";
      return {
        id: fileKey,
        type: "diff" as const,
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(`${collapsed ? "1" : "0"}:${viewedMark}:${annotationsVersion}`),
      };
    },
  );
  const fileKeys = items.map((item) => item.id);
  const collapsedFileKeys = new Set(
    items.filter((item) => item.collapsed === true).map((item) => item.id),
  );
  const allFilesCollapsed = areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys);

  // Do not re-arm the visible sentinel after failure; it would retry indefinitely.
  const canLoadNextSlice =
    nextCursor !== null &&
    nextCursor !== cursor &&
    !diffQuery.isPending &&
    diffQuery.error === null;
  const loadNextSlice = () => {
    if (nextCursor === null) return;
    setSliceState((previous) => ({ ...previous, cursor: nextCursor }));
  };
  const sentinelRef = (node: HTMLDivElement | null) => {
    if (node === null || !canLoadNextSlice) return;
    return observeIntersection(
      node,
      (entry) => {
        if (entry.isIntersecting) loadNextSlice();
      },
      { rootMargin: "240px" },
    );
  };

  const toggleFile = (fileKey: string) =>
    setToggledFiles((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });

  const setFileViewed = (fileKey: string, viewed: boolean, extendRange: boolean) => {
    const range = getFileViewedRange(
      annotatedFiles,
      fileKey,
      extendRange ? lastViewedFileKey : null,
    );
    setLastViewedFileKey(fileKey);
    for (const file of range) setViewed(file.path, viewed);
    setToggledFiles((current) =>
      range.reduce(
        (next, file) =>
          toggleFileDiffFoldForViewed(file.fileKey, viewed, effectiveFoldOverride, next),
        current,
      ),
    );
  };
  const fileViewedToggle = {
    enabled: filesViewedEnabled,
    isViewed: isFileViewed,
    isStale: isFileViewedStale,
    setFileViewed,
  };

  const revealFile = (path: string) => {
    const item = items.find((candidate) => resolveFileDiffPath(candidate.fileDiff) === path);
    if (item === undefined) return;
    // Unfold only: a second reveal before the unfold renders must not fold the file again.
    if (item.collapsed === true) {
      setToggledFiles((current) =>
        toggleFileDiffFoldForViewed(item.id, false, effectiveFoldOverride, current),
      );
    }
    codeViewReveal.request(item.id);
  };

  const toggleAllFiles = () => {
    setFoldOverride(areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? "expanded" : "folded");
    setToggledFiles(new Set());
  };

  const orderedCommits = // GitLab preserves UTC offsets, so compare instants.
    detail.commits.toSorted(
      (left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate),
    );

  const beginComment = (
    range: SelectedLineRange | null,
    context: { item: CodeViewItem<ReviewAnnotationGroup> },
  ) => {
    if (!range || !canSelectLines) return;
    const item = context.item;
    if (item.type !== "diff") return;
    const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === item.id);
    if (!file) return;
    // On a host without ranged comments a range collapses to its last line: one that silently
    // lost its first line there would be worse than one line.
    const path = resolveFileDiffPath(file);
    const previousPath = resolveFileDiffPreviousPath(file);
    const sourceFile = parsedSlices
      .flatMap((slice) => (slice?.kind === "files" ? slice.sourceFiles : []))
      .find((candidate) => resolveFileDiffPath(candidate) === path);
    const anchor =
      (sourceFile && resolveDiffReviewAnchor(sourceFile, range, rangeComments)) ??
      resolveDiffReviewAnchor(file, range, rangeComments);
    if (anchor === null) return;
    setDraft({
      fileKey: item.id,
      path,
      oldPath: previousPath === path ? null : previousPath,
      ...anchor,
      range,
    });
  };

  const finishSelection = (
    anchor: DraftAnchor,
    text: string,
    onFinish: (comment: ReviewCommentContext) => void,
  ) => {
    const file = files.find((candidate) => buildFileDiffRenderKey(candidate) === anchor.fileKey);
    const comment =
      file === undefined
        ? null
        : buildDiffReviewComment({
            id: `pull-request-selection:${anchor.fileKey}:${anchor.range.start}:${anchor.range.end}`,
            sectionId: `pull-request:${detail.number}`,
            sectionTitle: `PR #${detail.number} review`,
            filePath: anchor.path,
            fileDiff: file,
            range: anchor.range,
            text,
          });
    setDraft(null);
    setSelectedLines(null);
    if (comment !== null) onFinish(comment);
  };

  // Stable props preserve viewer portals during selection, typing, and review updates.
  const renderCodeViewFooter = () =>
    nextCursor === null ? null : (
      <div
        ref={sentinelRef}
        className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground"
      >
        {diffQuery.error !== null ? (
          <>
            <span>The rest of this diff could not be loaded.</span>
            <Button size="xs" variant="outline" onClick={() => diffQuery.refresh()}>
              Retry
            </Button>
          </>
        ) : diffQuery.isPending ? (
          "Loading more files..."
        ) : null}
      </div>
    );

  const renderHeaderPrefix = (item: CodeViewItem<ReviewAnnotationGroup>) => {
    const collapsed = item.collapsed === true;
    return (
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand diff" : "Collapse diff"}
        className="mr-1"
        onClick={(event) => {
          event.stopPropagation();
          toggleFile(item.id);
        }}
      >
        <MorphIcon className="size-4" icon={collapsed ? ChevronRight : ChevronDown} />
      </Button>
    );
  };

  const renderHeaderMetadata = (item: CodeViewItem<ReviewAnnotationGroup>) => {
    if (item.type !== "diff") return null;
    let { additions, deletions } = sourceFileStats.get(item.id) ?? getDiffLineStat([item.fileDiff]);
    const path = resolveFileDiffPath(item.fileDiff);
    if (additions === 0 && deletions === 0) {
      const withheld = omittedFileStats.get(path);
      if (withheld) ({ additions, deletions } = withheld);
    }
    return (
      <FileViewedToggle
        fileKey={item.id}
        path={path}
        stat={
          <PullRequestDiffStat
            additions={additions}
            deletions={deletions}
            className="font-mono text-2xs"
          />
        }
      />
    );
  };

  const diffViewOptions = {
    diffStyle: diffLayout === "split" ? ("split" as const) : ("unified" as const),
    lineDiffType: "none" as const,
    overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
    theme: resolveDiffThemeName(resolvedTheme),
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    themeType: resolvedTheme,
    stickyHeaders: true,
    loadDiffFiles,
    enableGutterUtility: canSelectLines && draft === null,
    enableLineSelection: canSelectLines && draft === null,
    onGutterUtilityClick: beginComment,
    onLineSelectionEnd: beginComment,
    onPostRender: codeViewReveal.flush,
  };


  return {
    addComment,
    allFilesCollapsed,
    isRevealAnswered,
    markRevealAnswered,
    canCommentOnLines,
    canLoadNextSlice,
    canSelectLines,
    codeViewReveal,
    commit,
    cursor,
    data,
    diffLayout,
    diffQuery,
    diffViewOptions,
    draft,
    effectiveFoldOverride,
    fileKeys,
    filePaths,
    fileTreeEntries,
    fileTreeOpen,
    fileViewedToggle,
    files,
    filesViewed,
    finishSelection,
    hiddenTestFileCount,
    hideTestFiles,
    ignoreWhitespace,
    isFileViewed,
    items,
    loadNextSlice,
    loadThreadComments,
    loadedSlices,
    nextCursor,
    orderedCommits,
    orphansOpen,
    placedThreadIds,
    rawSlicesView,
    removeComment,
    renderCodeViewFooter,
    renderHeaderMetadata,
    renderHeaderPrefix,
    replyToThread,
    revealFile,
    review,
    reviewKey,
    selectedLines,
    setDraft,
    setFileTreeOpen,
    setHideTestFiles,
    setIgnoreWhitespace,
    setOrphansOpen,
    setSelectedLines,
    setThreadPending,
    setThreadResolution,
    setToggledFiles,
    setVisibleCommitCount,
    setWordWrap,
    testFileCount,
    threadPending,
    toggleAllFiles,
    toggleFile,
    unstructured,
    updateComment,
    viewedFilesStore,
    visibleCommitCount,
    withheldContent,
    wordWrap,
  };
}
