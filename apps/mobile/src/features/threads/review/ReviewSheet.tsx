import { ThreadId, type OrchestrationCheckpointSummary } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import Stack from "expo-router/stack";
import { SymbolView } from "expo-symbols";
import { memo, type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text as NativeText,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";
import { getEnvironmentClient } from "../../../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../../../state/use-thread-detail";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useThreadDraftForThread } from "../use-thread-composer-state";
import {
  getCachedReviewParsedDiff,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  updateReviewExpandedFileIds,
  updateReviewRevealedLargeFileIds,
  useReviewCacheForThread,
} from "./reviewState";
import {
  getReadyReviewCheckpoints,
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReviewFilePreviewState,
  getReviewSectionIdForCheckpoint,
  type ReviewParsedDiff,
  type ReviewRenderableFile,
  type ReviewRenderableLineRow,
} from "./reviewModel";
import {
  getCachedHighlightedReviewFile,
  highlightReviewFile,
  type ReviewDiffTheme,
  type ReviewHighlightedFile,
  type ReviewHighlightedToken,
} from "./shikiReviewHighlighter";
import {
  buildReviewCommentTarget,
  clearReviewCommentTarget,
  countReviewCommentContexts,
  formatReviewSelectedRangeLabel,
  getReviewChangeMarker,
  getReviewUnifiedLineNumber,
  getSelectedReviewCommentLines,
  setReviewCommentTarget,
  type ReviewCommentTarget,
  useReviewCommentTarget,
} from "./reviewCommentSelection";
import { changeTone, DiffTokenText } from "./reviewDiffRendering";

interface PendingCommentSelection {
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly anchorIndex: number;
}

interface ReviewLineActionInput {
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly lineIndex: number;
}

const IOS_NAV_BAR_HEIGHT = 44;
const REVIEW_HEADER_SPACING = 32;

function changeTypeLabel(type: ReviewRenderableFile["changeType"]): string {
  switch (type) {
    case "new":
      return "Added";
    case "deleted":
      return "Deleted";
    case "rename-pure":
      return "Renamed";
    case "rename-changed":
      return "Renamed + edited";
    default:
      return "Edited";
  }
}

function formatHeaderDiffSummary(parsedDiff: ReviewParsedDiff): {
  readonly additions: string | null;
  readonly deletions: string | null;
} {
  if (parsedDiff.kind !== "files") {
    return { additions: null, deletions: null };
  }

  return {
    additions: `+${parsedDiff.additions}`,
    deletions: `-${parsedDiff.deletions}`,
  };
}

function getDefaultExpandedFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
): ReadonlyArray<string> {
  return files.map((file) => file.id);
}

const ReviewLineRow = memo(function ReviewLineRow(props: {
  readonly line: ReviewRenderableLineRow;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly viewportWidth: number;
  readonly selectionState: "anchor" | "selected" | null;
  readonly onComment: () => void;
  readonly onStartRangeSelection: () => void;
}) {
  const lineNumber = getReviewUnifiedLineNumber(props.line);

  return (
    <Pressable
      className={cn(
        "flex-row items-start",
        changeTone(props.line.change),
        props.selectionState === "anchor" && "bg-sky-500/16",
        props.selectionState === "selected" && "bg-amber-300/28",
      )}
      accessibilityRole="button"
      accessibilityLabel={
        lineNumber !== null
          ? props.selectionState === "anchor"
            ? `Range starts on line ${lineNumber}`
            : `Add comment on line ${lineNumber}`
          : "Add comment on line"
      }
      delayLongPress={220}
      onLongPress={props.onStartRangeSelection}
      onPress={props.onComment}
      style={{ minWidth: props.viewportWidth }}
    >
      <Text className="w-9 px-1 py-1 text-right text-[11px] font-t3-medium text-foreground-muted">
        {lineNumber ?? ""}
      </Text>
      <Text
        className="px-0.5 py-1 text-center font-mono text-[12px] text-foreground-muted"
        style={{ width: 18 }}
      >
        {getReviewChangeMarker(props.line.change)}
      </Text>
      <View className="min-w-0 flex-1 flex-shrink-0 px-1 py-1">
        <DiffTokenText tokens={props.tokens} fallback={props.line.content} />
      </View>
    </Pressable>
  );
});

const ReviewFileCard = memo(function ReviewFileCard(props: {
  readonly file: ReviewRenderableFile;
  readonly fileId: string;
  readonly expanded: boolean;
  readonly onToggleFile: (fileId: string) => void;
}) {
  return (
    <View className="border-b border-border bg-card" style={{ zIndex: 1 }}>
      <Pressable
        className="flex-row items-start gap-2 px-3 py-3"
        onPress={() => props.onToggleFile(props.fileId)}
      >
        <View className="pt-0.5">
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.right"}
            size={14}
            tintColor="#8a8a8a"
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="font-mono text-[13px] leading-[18px] text-foreground">
            {props.file.path}
          </Text>
          {props.file.previousPath && props.file.previousPath !== props.file.path ? (
            <Text className="font-mono text-[11px] leading-[16px] text-foreground-muted">
              {props.file.previousPath}
            </Text>
          ) : null}
        </View>
        <View className="items-end gap-1 pl-2">
          <Text className="text-[11px] font-t3-bold uppercase text-foreground-muted">
            {changeTypeLabel(props.file.changeType)}
          </Text>
          <View className="flex-row items-center gap-2">
            <Text className="text-[12px] font-t3-bold text-emerald-600">
              +{props.file.additions}
            </Text>
            <Text className="text-[12px] font-t3-bold text-rose-600">-{props.file.deletions}</Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
});

const ReviewFileBody = memo(function ReviewFileBody(props: {
  readonly file: ReviewRenderableFile;
  readonly sectionTitle: string;
  readonly highlightedFile: ReviewHighlightedFile | null;
  readonly viewportWidth: number;
  readonly pendingSelection: PendingCommentSelection | null;
  readonly selectedTarget: ReviewCommentTarget | null;
  readonly onPressLine: (input: ReviewLineActionInput) => void;
  readonly onStartRangeSelection: (input: ReviewLineActionInput) => void;
}) {
  const commentableLines = useMemo(
    () => props.file.rows.filter((row): row is ReviewRenderableLineRow => row.kind === "line"),
    [props.file.rows],
  );
  const lineIndexById = useMemo(
    () => new Map(commentableLines.map((line, index) => [line.id, index])),
    [commentableLines],
  );
  const anchorLineId = useMemo(
    () =>
      props.pendingSelection &&
      props.pendingSelection.sectionTitle === props.sectionTitle &&
      props.pendingSelection.filePath === props.file.path
        ? (props.pendingSelection.lines[props.pendingSelection.anchorIndex]?.id ?? null)
        : null,
    [props.file.path, props.pendingSelection, props.sectionTitle],
  );
  const selectedLineIds = useMemo(
    () =>
      props.selectedTarget &&
      props.selectedTarget.sectionTitle === props.sectionTitle &&
      props.selectedTarget.filePath === props.file.path
        ? new Set(getSelectedReviewCommentLines(props.selectedTarget).map((line) => line.id))
        : null,
    [props.file.path, props.sectionTitle, props.selectedTarget],
  );

  return (
    <ScrollView
      horizontal
      bounces={false}
      showsHorizontalScrollIndicator={false}
      className="border-b border-border bg-card"
    >
      <View style={{ minWidth: props.viewportWidth }}>
        {props.file.rows.map((row) => {
          if (row.kind === "hunk") {
            return (
              <View
                key={row.id}
                className="border-b border-border/60 bg-sky-500/10 px-2 py-2"
                style={{ minWidth: props.viewportWidth }}
              >
                <Text className="font-mono text-[12px] leading-[18px] text-sky-700 dark:text-sky-300">
                  {row.header}
                  {row.context ? ` ${row.context}` : ""}
                </Text>
              </View>
            );
          }

          const tokens =
            row.change === "delete"
              ? (props.highlightedFile?.deletionLines[row.deletionTokenIndex ?? -1] ?? null)
              : (props.highlightedFile?.additionLines[row.additionTokenIndex ?? -1] ?? null);

          return (
            <ReviewLineRow
              key={row.id}
              line={row}
              tokens={tokens}
              viewportWidth={props.viewportWidth}
              selectionState={
                anchorLineId === row.id
                  ? "anchor"
                  : selectedLineIds?.has(row.id)
                    ? "selected"
                    : null
              }
              onComment={() => {
                props.onPressLine({
                  sectionTitle: props.sectionTitle,
                  filePath: props.file.path,
                  lines: commentableLines,
                  lineIndex: lineIndexById.get(row.id) ?? 0,
                });
              }}
              onStartRangeSelection={() => {
                props.onStartRangeSelection({
                  sectionTitle: props.sectionTitle,
                  filePath: props.file.path,
                  lines: commentableLines,
                  lineIndex: lineIndexById.get(row.id) ?? 0,
                });
              }}
            />
          );
        })}
      </View>
    </ScrollView>
  );
});

const ReviewFileSuppressedBody = memo(function ReviewFileSuppressedBody(props: {
  readonly message: string;
  readonly actionLabel?: string | null;
  readonly fileId: string;
  readonly onLoadDiffFile?: (fileId: string) => void;
}) {
  return (
    <View className="gap-2 border-b border-border bg-card px-4 py-3">
      <Text className="text-[12px] leading-[18px] text-foreground-muted">{props.message}</Text>
      {props.actionLabel && props.onLoadDiffFile ? (
        <Pressable
          className="self-start rounded-full bg-subtle px-3 py-2"
          onPress={() => props.onLoadDiffFile?.(props.fileId)}
        >
          <Text className="text-[12px] font-t3-bold text-foreground">{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const ReviewFileItem = memo(function ReviewFileItem(props: {
  readonly file: ReviewRenderableFile;
  readonly expanded: boolean;
  readonly sectionTitle: string;
  readonly selectedTheme: ReviewDiffTheme;
  readonly pendingSelection: PendingCommentSelection | null;
  readonly selectedTarget: ReviewCommentTarget | null;
  readonly viewportWidth: number;
  readonly revealedLarge: boolean;
  readonly onToggleFile: (fileId: string) => void;
  readonly onLoadDiffFile: (fileId: string) => void;
  readonly onPressLine: (input: ReviewLineActionInput) => void;
  readonly onStartRangeSelection: (input: ReviewLineActionInput) => void;
}) {
  const previewState = useMemo(() => getReviewFilePreviewState(props.file), [props.file]);
  const shouldRenderBody =
    previewState.kind === "render" || (previewState.reason === "large" && props.revealedLarge);
  const highlightCacheKey = `${props.selectedTheme}:${props.file.cacheKey}`;
  const [highlightedFile, setHighlightedFile] = useState<ReviewHighlightedFile | null>(() =>
    getCachedHighlightedReviewFile(props.file, props.selectedTheme),
  );

  useEffect(() => {
    setHighlightedFile(getCachedHighlightedReviewFile(props.file, props.selectedTheme));
  }, [highlightCacheKey, props.file, props.selectedTheme]);

  useEffect(() => {
    if (!props.expanded || !shouldRenderBody) {
      return;
    }

    const cached = getCachedHighlightedReviewFile(props.file, props.selectedTheme);
    if (cached) {
      setHighlightedFile(cached);
      return;
    }

    let cancelled = false;
    void highlightReviewFile(props.file, props.selectedTheme)
      .then((result) => {
        if (!cancelled) {
          setHighlightedFile(result);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [highlightCacheKey, props.expanded, props.file, props.selectedTheme, shouldRenderBody]);

  return (
    <>
      <ReviewFileCard
        file={props.file}
        fileId={props.file.id}
        expanded={props.expanded}
        onToggleFile={props.onToggleFile}
      />
      {props.expanded ? (
        shouldRenderBody ? (
          <ReviewFileBody
            file={props.file}
            sectionTitle={props.sectionTitle}
            highlightedFile={highlightedFile}
            pendingSelection={props.pendingSelection}
            selectedTarget={props.selectedTarget}
            viewportWidth={props.viewportWidth}
            onPressLine={props.onPressLine}
            onStartRangeSelection={props.onStartRangeSelection}
          />
        ) : (
          <ReviewFileSuppressedBody
            message={previewState.message}
            actionLabel={previewState.actionLabel}
            fileId={props.file.id}
            onLoadDiffFile={previewState.actionLabel ? props.onLoadDiffFile : undefined}
          />
        )
      ) : null}
    </>
  );
});

const ReviewNotice = memo(function ReviewNotice(props: { readonly notice: string }) {
  return (
    <View className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40">
      <Text className="text-[12px] font-t3-bold uppercase text-amber-700 dark:text-amber-300">
        Partial diff
      </Text>
      <Text className="text-[12px] leading-[18px] text-amber-800 dark:text-amber-200">
        {props.notice}
      </Text>
    </View>
  );
});

function ReviewSelectionActionBar(props: {
  readonly target: ReviewCommentTarget | null;
  readonly bottomInset: number;
  readonly onOpenComment: () => void;
  readonly onClear: () => void;
}) {
  if (!props.target || props.target.startIndex === props.target.endIndex) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 18,
        right: 18,
        bottom: Math.max(props.bottomInset, 10) + 18,
        flexDirection: "row",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <Pressable
        className="min-h-[48px] flex-1 flex-row items-center justify-center gap-2 rounded-full bg-blue-600 px-5"
        onPress={props.onOpenComment}
      >
        <SymbolView name="text.bubble" size={16} tintColor="#ffffff" type="monochrome" />
        <Text className="text-[15px] font-t3-bold text-white">
          Comment on {formatReviewSelectedRangeLabel(props.target)}
        </Text>
      </Pressable>

      <Pressable
        className="h-12 w-12 items-center justify-center rounded-full bg-blue-600"
        onPress={props.onClear}
      >
        <SymbolView name="xmark" size={16} tintColor="#ffffff" type="monochrome" />
      </Pressable>
    </View>
  );
}

export function ReviewSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const headerForeground = String(useThemeColor("--color-foreground"));
  const headerMuted = String(useThemeColor("--color-foreground-muted"));
  const headerIcon = String(useThemeColor("--color-icon"));
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: string;
    threadId: string;
  }>();
  const { draftMessage } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const { selectedThreadProject } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const [loadingTurnIds, setLoadingTurnIds] = useState<Record<string, boolean>>({});
  const [loadingGitDiffs, setLoadingGitDiffs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] =
    useState<PendingCommentSelection | null>(null);
  const activeCommentTarget = useReviewCommentTarget();

  const cwd = selectedThread?.worktreePath ?? selectedThreadProject?.workspaceRoot ?? null;
  const readyCheckpoints = useMemo(
    () => getReadyReviewCheckpoints(selectedThread?.checkpoints ?? []),
    [selectedThread?.checkpoints],
  );

  const checkpointBySectionId = useMemo(() => {
    return Object.fromEntries(
      readyCheckpoints.map((checkpoint) => [
        getReviewSectionIdForCheckpoint(checkpoint),
        checkpoint,
      ]),
    ) as Record<string, OrchestrationCheckpointSummary>;
  }, [readyCheckpoints]);

  const reviewSections = useMemo(
    () =>
      buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections: reviewCache.gitSections,
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
      }),
    [loadingTurnIds, readyCheckpoints, reviewCache.gitSections, reviewCache.turnDiffById],
  );

  const selectedSection =
    reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
    reviewSections[0] ??
    null;
  const topContentInset = insets.top + IOS_NAV_BAR_HEIGHT;
  const parsedDiff = useMemo(
    () =>
      getCachedReviewParsedDiff({
        threadKey: reviewCache.threadKey,
        sectionId: selectedSection?.id ?? null,
        diff: selectedSection?.diff,
      }),
    [reviewCache.threadKey, selectedSection?.diff, selectedSection?.id],
  );
  const headerDiffSummary = useMemo(() => formatHeaderDiffSummary(parsedDiff), [parsedDiff]);
  const pendingReviewCommentCount = useMemo(
    () => countReviewCommentContexts(draftMessage),
    [draftMessage],
  );

  const selectedTheme = (colorScheme === "dark" ? "dark" : "light") satisfies ReviewDiffTheme;
  const expandedFileIds = useMemo(
    () =>
      selectedSection?.id && parsedDiff.kind === "files"
        ? (reviewCache.expandedFileIdsBySection[selectedSection.id] ??
          getDefaultExpandedFileIds(parsedDiff.files))
        : [],
    [parsedDiff, reviewCache.expandedFileIdsBySection, selectedSection?.id],
  );
  const revealedLargeFileIds = useMemo(
    () =>
      selectedSection?.id
        ? (reviewCache.revealedLargeFileIdsBySection[selectedSection.id] ?? [])
        : [],
    [reviewCache.revealedLargeFileIdsBySection, selectedSection?.id],
  );
  const loadGitDiffs = useCallback(async () => {
    if (!environmentId || !cwd) {
      return;
    }

    const client = getEnvironmentClient(environmentId);
    if (!client) {
      setError("Remote connection is not ready.");
      return;
    }

    setLoadingGitDiffs(true);
    setError(null);
    try {
      const result = await client.git.getReviewDiffs({ cwd });
      if (reviewCache.threadKey) {
        setReviewGitSections(reviewCache.threadKey, result.sections);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load review diffs.");
    } finally {
      setLoadingGitDiffs(false);
    }
  }, [cwd, environmentId, reviewCache.threadKey]);

  const loadTurnDiff = useCallback(
    async (checkpoint: OrchestrationCheckpointSummary, force = false) => {
      if (!environmentId || !threadId) {
        return;
      }

      const sectionId = getReviewSectionIdForCheckpoint(checkpoint);
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }

      if (!force && reviewCache.turnDiffById[sectionId] !== undefined) {
        return;
      }

      const client = getEnvironmentClient(environmentId);
      if (!client) {
        setError("Remote connection is not ready.");
        return;
      }

      setLoadingTurnIds((current) => ({ ...current, [sectionId]: true }));
      setError(null);
      try {
        const result = await client.orchestration.getTurnDiff({
          threadId: ThreadId.make(threadId),
          fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
          toTurnCount: checkpoint.checkpointTurnCount,
        });
        if (reviewCache.threadKey) {
          setReviewTurnDiff(reviewCache.threadKey, sectionId, result.diff);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to load turn diff.");
      } finally {
        setLoadingTurnIds((current) => {
          const next = { ...current };
          delete next[sectionId];
          return next;
        });
      }
    },
    [environmentId, reviewCache.threadKey, reviewCache.turnDiffById, threadId],
  );

  useEffect(() => {
    void loadGitDiffs();
  }, [loadGitDiffs]);

  useEffect(() => {
    if (reviewSections.length === 0) {
      return;
    }

    const fallbackId = getDefaultReviewSectionId(reviewSections);
    if (
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId ||
        !reviewSections.some((section) => section.id === reviewCache.selectedSectionId))
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackId);
    }
  }, [reviewCache.selectedSectionId, reviewCache.threadKey, reviewSections]);

  useEffect(() => {
    const latest = readyCheckpoints[0];
    if (!latest) {
      return;
    }

    const latestId = getReviewSectionIdForCheckpoint(latest);
    if (reviewCache.turnDiffById[latestId] !== undefined || loadingTurnIds[latestId]) {
      return;
    }

    void loadTurnDiff(latest);
  }, [loadTurnDiff, loadingTurnIds, readyCheckpoints, reviewCache.turnDiffById]);

  useEffect(() => {
    if (!selectedSection || selectedSection.kind !== "turn" || selectedSection.diff !== null) {
      return;
    }

    const checkpoint = checkpointBySectionId[selectedSection.id];
    if (checkpoint && !loadingTurnIds[selectedSection.id]) {
      void loadTurnDiff(checkpoint);
    }
  }, [checkpointBySectionId, loadTurnDiff, loadingTurnIds, selectedSection]);

  useEffect(() => {
    if (!reviewCache.threadKey || !selectedSection?.id || parsedDiff.kind !== "files") {
      return;
    }

    updateReviewExpandedFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
      if (existing !== undefined) {
        const validIds = existing.filter((id) => parsedDiff.files.some((file) => file.id === id));
        if (validIds.length === existing.length) {
          return existing;
        }
        return validIds;
      }

      return getDefaultExpandedFileIds(parsedDiff.files);
    });
  }, [parsedDiff, reviewCache.threadKey, selectedSection?.id]);

  useEffect(() => {
    if (!reviewCache.threadKey || !selectedSection?.id || parsedDiff.kind !== "files") {
      return;
    }

    updateReviewRevealedLargeFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
      if (existing === undefined) {
        return undefined;
      }

      const validIds = existing.filter((id) => parsedDiff.files.some((file) => file.id === id));
      if (validIds.length === existing.length) {
        return existing;
      }

      return validIds;
    });
  }, [parsedDiff, reviewCache.threadKey, selectedSection?.id]);

  const refreshSelectedSection = useCallback(async () => {
    if (!selectedSection) {
      return;
    }

    if (selectedSection.kind === "turn") {
      const checkpoint = checkpointBySectionId[selectedSection.id];
      if (checkpoint) {
        await loadTurnDiff(checkpoint, true);
      }
      return;
    }

    await loadGitDiffs();
  }, [checkpointBySectionId, loadGitDiffs, loadTurnDiff, selectedSection]);

  const handleToggleExpandedFile = useCallback(
    (fileId: string) => {
      if (!reviewCache.threadKey || !selectedSection?.id || parsedDiff.kind !== "files") {
        return;
      }

      updateReviewExpandedFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
        const currentIds = existing ?? getDefaultExpandedFileIds(parsedDiff.files);
        return currentIds.includes(fileId)
          ? currentIds.filter((id) => id !== fileId)
          : [...currentIds, fileId];
      });
    },
    [parsedDiff, reviewCache.threadKey, selectedSection?.id],
  );

  const handleRevealLargeDiff = useCallback(
    (fileId: string) => {
      if (!reviewCache.threadKey || !selectedSection?.id) {
        return;
      }

      updateReviewRevealedLargeFileIds(reviewCache.threadKey, selectedSection.id, (existing) => {
        const currentIds = existing ?? [];
        return currentIds.includes(fileId) ? currentIds : [...currentIds, fileId];
      });
    },
    [reviewCache.threadKey, selectedSection?.id],
  );

  const handlePressLine = useCallback(
    (input: ReviewLineActionInput) => {
      if (pendingCommentSelection) {
        if (
          pendingCommentSelection.sectionTitle === input.sectionTitle &&
          pendingCommentSelection.filePath === input.filePath
        ) {
          setReviewCommentTarget(
            buildReviewCommentTarget(
              {
                sectionTitle: pendingCommentSelection.sectionTitle,
                filePath: pendingCommentSelection.filePath,
                lines: pendingCommentSelection.lines,
              },
              pendingCommentSelection.anchorIndex,
              input.lineIndex,
            ),
          );
          setPendingCommentSelection(null);
          return;
        }

        clearReviewCommentTarget();
        setPendingCommentSelection({
          sectionTitle: input.sectionTitle,
          filePath: input.filePath,
          lines: input.lines,
          anchorIndex: input.lineIndex,
        });
        return;
      }

      setReviewCommentTarget({
        sectionTitle: input.sectionTitle,
        filePath: input.filePath,
        lines: input.lines,
        startIndex: input.lineIndex,
        endIndex: input.lineIndex,
      });
      if (environmentId && threadId) {
        router.push({
          pathname: "/threads/[environmentId]/[threadId]/review-comment",
          params: { environmentId, threadId },
        });
      }
    },
    [environmentId, pendingCommentSelection, router, threadId],
  );

  const handleStartRangeSelection = useCallback((input: ReviewLineActionInput) => {
    clearReviewCommentTarget();
    setPendingCommentSelection({
      sectionTitle: input.sectionTitle,
      filePath: input.filePath,
      lines: input.lines,
      anchorIndex: input.lineIndex,
    });
  }, []);

  const parsedDiffNotice =
    parsedDiff.kind === "files" || parsedDiff.kind === "raw" ? parsedDiff.notice : null;

  const listHeader = useMemo(() => {
    const children: ReactElement[] = [];

    if (error) {
      children.push(
        <View key="review-error" className="border-b border-border bg-card px-4 py-3">
          <Text className="text-[13px] font-t3-bold text-foreground">Review unavailable</Text>
          <Text className="text-[12px] leading-[18px] text-foreground-muted">{error}</Text>
        </View>,
      );
    }

    if (parsedDiffNotice) {
      children.push(<ReviewNotice key="review-notice" notice={parsedDiffNotice} />);
    }

    if (children.length === 0) {
      return null;
    }

    return <>{children}</>;
  }, [error, parsedDiffNotice]);

  const renderFileItem = useCallback(
    ({ item }: { item: ReviewRenderableFile; index: number }) => {
      if (!selectedSection) {
        return null;
      }
      const pendingSelectionForFile =
        pendingCommentSelection &&
        pendingCommentSelection.sectionTitle === selectedSection.title &&
        pendingCommentSelection.filePath === item.path
          ? pendingCommentSelection
          : null;
      const selectedTargetForFile =
        activeCommentTarget &&
        activeCommentTarget.sectionTitle === selectedSection.title &&
        activeCommentTarget.filePath === item.path
          ? activeCommentTarget
          : null;

      return (
        <ReviewFileItem
          file={item}
          expanded={expandedFileIds.includes(item.id)}
          sectionTitle={selectedSection.title}
          selectedTheme={selectedTheme}
          pendingSelection={pendingSelectionForFile}
          selectedTarget={selectedTargetForFile}
          viewportWidth={Math.max(width, 280)}
          revealedLarge={revealedLargeFileIds.includes(item.id)}
          onToggleFile={handleToggleExpandedFile}
          onLoadDiffFile={handleRevealLargeDiff}
          onPressLine={handlePressLine}
          onStartRangeSelection={handleStartRangeSelection}
        />
      );
    },
    [
      activeCommentTarget,
      expandedFileIds,
      handlePressLine,
      handleRevealLargeDiff,
      handleStartRangeSelection,
      handleToggleExpandedFile,
      pendingCommentSelection,
      revealedLargeFileIds,
      selectedSection,
      selectedTheme,
      width,
    ],
  );

  const visibleListExtraData = useMemo(() => {
    return {
      selectedSectionId: selectedSection?.id ?? null,
      selectedTheme,
      expandedFileIds,
      revealedLargeFileIds,
      pendingSelection: pendingCommentSelection,
      selectedTarget: activeCommentTarget,
      viewportWidth: Math.max(width, 280),
    };
  }, [
    activeCommentTarget,
    expandedFileIds,
    pendingCommentSelection,
    revealedLargeFileIds,
    selectedSection,
    selectedTheme,
    width,
  ]);

  return (
    <>
      <Stack.Screen
        options={{
          headerTransparent: true,
          headerShadowVisible: false,
          headerTintColor: headerIcon,
          headerStyle: {
            backgroundColor: "transparent",
          },
          headerTitle: () => (
            <View style={{ alignItems: "center" }}>
              <NativeText
                numberOfLines={1}
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: 18,
                  fontWeight: "900",
                  color: headerForeground,
                  letterSpacing: -0.4,
                }}
              >
                Files Changed
              </NativeText>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {headerDiffSummary.additions && headerDiffSummary.deletions ? (
                  <>
                    <NativeText
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: "#16a34a",
                      }}
                    >
                      {headerDiffSummary.additions}
                    </NativeText>
                    <NativeText
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: "#e11d48",
                      }}
                    >
                      {headerDiffSummary.deletions}
                    </NativeText>
                    {pendingReviewCommentCount > 0 ? (
                      <NativeText
                        style={{
                          fontFamily: "DMSans_700Bold",
                          fontSize: 12,
                          fontWeight: "700",
                          color: "#b45309",
                        }}
                      >
                        {pendingReviewCommentCount} pending
                      </NativeText>
                    ) : null}
                  </>
                ) : (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <NativeText
                      numberOfLines={1}
                      style={{
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        color: headerMuted,
                      }}
                    >
                      {selectedSection?.title ?? "Review changes"}
                    </NativeText>
                    {pendingReviewCommentCount > 0 ? (
                      <NativeText
                        style={{
                          fontFamily: "DMSans_700Bold",
                          fontSize: 12,
                          fontWeight: "700",
                          color: "#b45309",
                        }}
                      >
                        {pendingReviewCommentCount} pending
                      </NativeText>
                    ) : null}
                  </View>
                )}
              </View>
            </View>
          ),
        }}
      />

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis.circle" title="Select diff" separateBackground>
          {reviewSections.map((section) => (
            <Stack.Toolbar.MenuAction
              key={section.id}
              icon={section.id === selectedSection?.id ? "checkmark" : "circle"}
              onPress={() => {
                if (reviewCache.threadKey) {
                  setReviewSelectedSectionId(reviewCache.threadKey, section.id);
                }
              }}
              subtitle={section.subtitle ?? undefined}
            >
              <Stack.Toolbar.Label>{section.title}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          ))}
          <Stack.Toolbar.MenuAction
            icon="arrow.clockwise"
            disabled={
              loadingGitDiffs ||
              (selectedSection?.kind === "turn" && loadingTurnIds[selectedSection.id] === true)
            }
            onPress={() => void refreshSelectedSection()}
            subtitle="Reload current diff"
          >
            <Stack.Toolbar.Label>Refresh</Stack.Toolbar.Label>
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <View className="flex-1 bg-sheet">
        {selectedSection && parsedDiff.kind === "files" ? (
          <LegendList
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="never"
            contentInset={{ top: topContentInset }}
            scrollIndicatorInsets={{ top: topContentInset }}
            data={parsedDiff.files as ReviewRenderableFile[]}
            renderItem={renderFileItem}
            keyExtractor={(file) => file.id}
            extraData={visibleListExtraData}
            keyboardShouldPersistTaps="handled"
            estimatedItemSize={220}
            drawDistance={900}
            recycleItems
            ListHeaderComponent={listHeader}
            contentContainerStyle={{
              paddingTop: REVIEW_HEADER_SPACING,
              paddingBottom: Math.max(insets.bottom, 18) + 18,
            }}
          />
        ) : (
          <ScrollView
            contentInsetAdjustmentBehavior="never"
            contentInset={{ top: topContentInset }}
            contentOffset={{ x: 0, y: -topContentInset }}
            scrollIndicatorInsets={{ top: topContentInset }}
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingTop: REVIEW_HEADER_SPACING,
              paddingBottom: Math.max(insets.bottom, 18) + 18,
            }}
          >
            {listHeader}
            {!selectedSection ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-[14px] font-t3-bold text-foreground">No review diffs</Text>
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  This thread has no ready turn diffs and the worktree diff is empty.
                </Text>
              </View>
            ) : selectedSection.isLoading && selectedSection.diff === null ? (
              <View className="items-center gap-3 border-b border-border bg-card px-4 py-6">
                <ActivityIndicator size="small" />
                <Text className="text-[12px] text-foreground-muted">Loading diff…</Text>
              </View>
            ) : parsedDiff.kind === "empty" ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-[14px] font-t3-bold text-foreground">No changes</Text>
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  {selectedSection.subtitle ?? "This diff is empty."}
                </Text>
              </View>
            ) : parsedDiff.kind === "raw" ? (
              <View className="gap-3 border-b border-border bg-card px-4 py-4">
                <Text className="text-[12px] leading-[18px] text-foreground-muted">
                  {parsedDiff.reason}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                  <Text selectable className="font-mono text-[12px] leading-[19px] text-foreground">
                    {parsedDiff.text}
                  </Text>
                </ScrollView>
              </View>
            ) : null}
          </ScrollView>
        )}

        <ReviewSelectionActionBar
          target={activeCommentTarget}
          bottomInset={insets.bottom}
          onOpenComment={() => {
            if (activeCommentTarget && environmentId && threadId) {
              router.push({
                pathname: "/threads/[environmentId]/[threadId]/review-comment",
                params: { environmentId, threadId },
              });
            }
          }}
          onClear={() => {
            clearReviewCommentTarget();
            setPendingCommentSelection(null);
          }}
        />
      </View>
    </>
  );
}
