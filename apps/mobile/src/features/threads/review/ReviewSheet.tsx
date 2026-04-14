import {
  ThreadId,
  type GitReviewDiffSection,
  type OrchestrationCheckpointSummary,
} from "@t3tools/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import Stack from "expo-router/stack";
import { SymbolView } from "expo-symbols";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
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
import {
  buildReviewParsedDiff,
  getReadyReviewCheckpoints,
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReviewSectionIdForCheckpoint,
  type ReviewRenderableFile,
  type ReviewRenderableLineRow,
} from "./reviewModel";
import {
  highlightReviewFile,
  type ReviewDiffTheme,
  type ReviewHighlightedFile,
  type ReviewHighlightedToken,
} from "./shikiReviewHighlighter";
import {
  buildReviewCommentTarget,
  clearReviewCommentTarget,
  formatReviewSelectedRangeLabel,
  getReviewChangeMarker,
  getReviewUnifiedLineNumber,
  getSelectedReviewCommentLines,
  setReviewCommentTarget,
  type ReviewCommentTarget,
  useReviewCommentTarget,
} from "./reviewCommentSelection";

interface PendingCommentSelection {
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly lines: ReadonlyArray<ReviewRenderableLineRow>;
  readonly anchorIndex: number;
}

const REVIEW_MONO_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});
const IOS_NAV_BAR_HEIGHT = 44;
const REVIEW_HEADER_SPACING = 32;

function changeTone(change: ReviewRenderableLineRow["change"]): string {
  if (change === "add") return "bg-emerald-500/12";
  if (change === "delete") return "bg-rose-500/12";
  return "bg-card";
}

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

function formatHeaderDiffSummary(parsedDiff: ReturnType<typeof buildReviewParsedDiff>): {
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

function shouldAutoExpandFile(file: ReviewRenderableFile): boolean {
  return file.additions + file.deletions <= 20 && file.rows.length <= 40;
}

function getDefaultExpandedFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
): ReadonlyArray<string> {
  const autoExpanded = files.filter(shouldAutoExpandFile).map((file) => file.id);
  if (autoExpanded.length > 0) {
    return autoExpanded;
  }
  return files.length === 1 ? [files[0]!.id] : [];
}

function renderVisibleWhitespace(value: string): string {
  const expandedTabs = value.replace(/\t/g, "    ");
  return expandedTabs.replace(/^( +)/, (leading) => leading.replaceAll(" ", "\u00A0"));
}

function DiffTokenText(props: {
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly fallback: string;
}) {
  if (!props.tokens || props.tokens.length === 0) {
    return (
      <NativeText
        selectable
        className="text-[12px] leading-[19px] text-foreground"
        style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
      >
        {renderVisibleWhitespace(props.fallback || " ")}
      </NativeText>
    );
  }

  return (
    <NativeText
      selectable
      className="text-[12px] leading-[19px] text-foreground"
      style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
    >
      {(() => {
        let offset = 0;

        return props.tokens.map((token) => {
          const start = offset;
          offset += token.content.length;

          const fontWeight =
            token.fontStyle !== null && (token.fontStyle & 2) === 2
              ? ("700" as const)
              : ("400" as const);
          const fontStyle =
            token.fontStyle !== null && (token.fontStyle & 1) === 1
              ? ("italic" as const)
              : ("normal" as const);

          return (
            <NativeText
              key={`${start}:${token.content.length}:${token.color ?? ""}:${token.fontStyle ?? ""}`}
              selectable
              style={{
                color: token.color ?? undefined,
                fontFamily: REVIEW_MONO_FONT_FAMILY,
                fontWeight,
                fontStyle,
              }}
            >
              {token.content.length > 0 ? renderVisibleWhitespace(token.content) : " "}
            </NativeText>
          );
        });
      })()}
    </NativeText>
  );
}

function ReviewLineRow(props: {
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
        "flex-row items-start border-b border-border/60",
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
      <Text className="w-9 px-1 py-2 text-right text-[11px] font-t3-medium text-foreground-muted">
        {lineNumber ?? ""}
      </Text>
      <Text
        className="px-0.5 py-2 text-center font-mono text-[12px] text-foreground-muted"
        style={{ width: 18 }}
      >
        {getReviewChangeMarker(props.line.change)}
      </Text>
      <View className="min-w-0 flex-1 flex-shrink-0 px-1 py-2">
        <DiffTokenText tokens={props.tokens} fallback={props.line.content} />
      </View>
    </Pressable>
  );
}

function ReviewFileCard(props: {
  readonly file: ReviewRenderableFile;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <View className="border-b border-border bg-card" style={{ zIndex: 1 }}>
      <Pressable className="flex-row items-start gap-2 px-3 py-3" onPress={props.onToggle}>
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
}

function ReviewFileBody(props: {
  readonly file: ReviewRenderableFile;
  readonly sectionTitle: string;
  readonly highlightedFile: ReviewHighlightedFile | null;
  readonly viewportWidth: number;
  readonly pendingSelection: PendingCommentSelection | null;
  readonly selectedTarget: ReviewCommentTarget | null;
  readonly onPressLine: (
    line: ReviewRenderableLineRow,
    availableLines: ReadonlyArray<ReviewRenderableLineRow>,
    lineIndex: number,
  ) => void;
  readonly onStartRangeSelection: (
    line: ReviewRenderableLineRow,
    availableLines: ReadonlyArray<ReviewRenderableLineRow>,
    lineIndex: number,
  ) => void;
}) {
  const commentableLines = props.file.rows.filter(
    (row): row is ReviewRenderableLineRow => row.kind === "line",
  );
  const anchorLineId =
    props.pendingSelection &&
    props.pendingSelection.sectionTitle === props.sectionTitle &&
    props.pendingSelection.filePath === props.file.path
      ? (props.pendingSelection.lines[props.pendingSelection.anchorIndex]?.id ?? null)
      : null;
  const selectedLineIds =
    props.selectedTarget &&
    props.selectedTarget.sectionTitle === props.sectionTitle &&
    props.selectedTarget.filePath === props.file.path
      ? new Set(getSelectedReviewCommentLines(props.selectedTarget).map((line) => line.id))
      : null;

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
                const lineIndex = commentableLines.findIndex(
                  (candidate) => candidate.id === row.id,
                );
                props.onPressLine(row, commentableLines, lineIndex >= 0 ? lineIndex : 0);
              }}
              onStartRangeSelection={() => {
                const lineIndex = commentableLines.findIndex(
                  (candidate) => candidate.id === row.id,
                );
                props.onStartRangeSelection(row, commentableLines, lineIndex >= 0 ? lineIndex : 0);
              }}
            />
          );
        })}
      </View>
    </ScrollView>
  );
}

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
  const { selectedThreadProject } = useThreadSelection();
  const selectedThread = useSelectedThreadDetail();
  const [gitSections, setGitSections] = useState<ReadonlyArray<GitReviewDiffSection>>([]);
  const [turnDiffById, setTurnDiffById] = useState<Record<string, string>>({});
  const [loadingTurnIds, setLoadingTurnIds] = useState<Record<string, boolean>>({});
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [loadingGitDiffs, setLoadingGitDiffs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFileIdsBySection, setExpandedFileIdsBySection] = useState<
    Record<string, ReadonlyArray<string> | undefined>
  >({});
  const [highlightedFileByKey, setHighlightedFileByKey] = useState<
    Record<string, ReviewHighlightedFile>
  >({});
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
        gitSections,
        turnDiffById,
        loadingTurnIds,
      }),
    [gitSections, loadingTurnIds, readyCheckpoints, turnDiffById],
  );

  const selectedSection =
    reviewSections.find((section) => section.id === selectedSectionId) ?? reviewSections[0] ?? null;
  const topContentInset = insets.top + IOS_NAV_BAR_HEIGHT;
  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(selectedSection?.diff, selectedSection?.id ?? "mobile-review"),
    [selectedSection?.diff, selectedSection?.id],
  );
  const headerDiffSummary = useMemo(() => formatHeaderDiffSummary(parsedDiff), [parsedDiff]);

  const selectedTheme = (colorScheme === "dark" ? "dark" : "light") satisfies ReviewDiffTheme;
  const expandedFileIds = useMemo(
    () =>
      selectedSection?.id && parsedDiff.kind === "files"
        ? (expandedFileIdsBySection[selectedSection.id] ??
          getDefaultExpandedFileIds(parsedDiff.files))
        : [],
    [expandedFileIdsBySection, parsedDiff, selectedSection?.id],
  );
  const expandedFiles = useMemo(
    () =>
      parsedDiff.kind === "files"
        ? parsedDiff.files.filter((file) => expandedFileIds.includes(file.id))
        : [],
    [expandedFileIds, parsedDiff],
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
      setGitSections(result.sections);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load review diffs.");
    } finally {
      setLoadingGitDiffs(false);
    }
  }, [cwd, environmentId]);

  const loadTurnDiff = useCallback(
    async (checkpoint: OrchestrationCheckpointSummary, force = false) => {
      if (!environmentId || !threadId) {
        return;
      }

      const sectionId = getReviewSectionIdForCheckpoint(checkpoint);
      setSelectedSectionId(sectionId);

      if (!force && turnDiffById[sectionId] !== undefined) {
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
        setTurnDiffById((current) => ({ ...current, [sectionId]: result.diff }));
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
    [environmentId, threadId, turnDiffById],
  );

  useEffect(() => {
    void loadGitDiffs();
  }, [loadGitDiffs]);

  useEffect(() => {
    if (reviewSections.length === 0) {
      return;
    }

    const fallbackId = getDefaultReviewSectionId(reviewSections);
    if (!selectedSectionId || !reviewSections.some((section) => section.id === selectedSectionId)) {
      setSelectedSectionId(fallbackId);
    }
  }, [reviewSections, selectedSectionId]);

  useEffect(() => {
    const latest = readyCheckpoints[0];
    if (!latest) {
      return;
    }

    const latestId = getReviewSectionIdForCheckpoint(latest);
    if (turnDiffById[latestId] !== undefined || loadingTurnIds[latestId]) {
      return;
    }

    void loadTurnDiff(latest);
  }, [loadTurnDiff, loadingTurnIds, readyCheckpoints, turnDiffById]);

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
    if (!selectedSectionId || parsedDiff.kind !== "files") {
      return;
    }

    setExpandedFileIdsBySection((current) => {
      const existing = current[selectedSectionId];
      if (existing !== undefined) {
        const validIds = existing.filter((id) => parsedDiff.files.some((file) => file.id === id));
        if (validIds.length === existing.length) {
          return current;
        }
        return { ...current, [selectedSectionId]: validIds };
      }

      return {
        ...current,
        [selectedSectionId]: getDefaultExpandedFileIds(parsedDiff.files),
      };
    });
  }, [parsedDiff, selectedSectionId]);

  useEffect(() => {
    if (!selectedSection || expandedFiles.length === 0) {
      return;
    }

    const filesToHighlight = expandedFiles.filter((file) => {
      const key = `${selectedSection.id}:${selectedTheme}:${file.cacheKey}`;
      return highlightedFileByKey[key] === undefined;
    });
    if (filesToHighlight.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(
      filesToHighlight.map(
        async (file) =>
          [
            `${selectedSection.id}:${selectedTheme}:${file.cacheKey}`,
            await highlightReviewFile(file, selectedTheme),
          ] as const,
      ),
    )
      .then((entries) => {
        if (!cancelled) {
          setHighlightedFileByKey((current) => ({
            ...current,
            ...Object.fromEntries(entries),
          }));
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
  }, [expandedFiles, highlightedFileByKey, selectedSection, selectedTheme]);

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

  const reviewContent = useMemo(() => {
    const children: ReactElement[] = [];
    const stickyHeaderIndices: number[] = [];

    if (error) {
      children.push(
        <View key="review-error" className="border-b border-border bg-card px-4 py-3">
          <Text className="text-[13px] font-t3-bold text-foreground">Review unavailable</Text>
          <Text className="text-[12px] leading-[18px] text-foreground-muted">{error}</Text>
        </View>,
      );
    }

    if (parsedDiff.kind !== "empty" && parsedDiff.notice) {
      children.push(
        <View
          key="review-notice"
          className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40"
        >
          <Text className="text-[12px] font-t3-bold uppercase text-amber-700 dark:text-amber-300">
            Partial diff
          </Text>
          <Text className="text-[12px] leading-[18px] text-amber-800 dark:text-amber-200">
            {parsedDiff.notice}
          </Text>
        </View>,
      );
    }

    if (!selectedSection) {
      children.push(
        <View key="review-empty-state" className="border-b border-border bg-card px-4 py-5">
          <Text className="text-[14px] font-t3-bold text-foreground">No review diffs</Text>
          <Text className="text-[12px] leading-[18px] text-foreground-muted">
            This thread has no ready turn diffs and the worktree diff is empty.
          </Text>
        </View>,
      );
      return { children, stickyHeaderIndices };
    }

    if (selectedSection.isLoading && selectedSection.diff === null) {
      children.push(
        <View
          key="review-loading"
          className="items-center gap-3 border-b border-border bg-card px-4 py-6"
        >
          <ActivityIndicator size="small" />
          <Text className="text-[12px] text-foreground-muted">Loading diff…</Text>
        </View>,
      );
      return { children, stickyHeaderIndices };
    }

    if (parsedDiff.kind === "empty") {
      children.push(
        <View key="review-no-changes" className="border-b border-border bg-card px-4 py-5">
          <Text className="text-[14px] font-t3-bold text-foreground">No changes</Text>
          <Text className="text-[12px] leading-[18px] text-foreground-muted">
            {selectedSection.subtitle ?? "This diff is empty."}
          </Text>
        </View>,
      );
      return { children, stickyHeaderIndices };
    }

    if (parsedDiff.kind === "raw") {
      children.push(
        <View key="review-raw" className="gap-3 border-b border-border bg-card px-4 py-4">
          <Text className="text-[12px] leading-[18px] text-foreground-muted">
            {parsedDiff.reason}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
            <Text selectable className="font-mono text-[12px] leading-[19px] text-foreground">
              {parsedDiff.text}
            </Text>
          </ScrollView>
        </View>,
      );
      return { children, stickyHeaderIndices };
    }

    parsedDiff.files.forEach((file) => {
      const isExpanded = expandedFileIds.includes(file.id);
      const fileHighlightKey = `${selectedSection.id}:${selectedTheme}:${file.cacheKey}`;
      const fileHighlights = highlightedFileByKey[fileHighlightKey] ?? null;

      stickyHeaderIndices.push(children.length);
      children.push(
        <ReviewFileCard
          key={`review-file-header:${file.id}`}
          file={file}
          expanded={isExpanded}
          onToggle={() =>
            setExpandedFileIdsBySection((current) => {
              const existing =
                current[selectedSection.id] ?? getDefaultExpandedFileIds(parsedDiff.files);
              const next = existing.includes(file.id)
                ? existing.filter((id) => id !== file.id)
                : [...existing, file.id];
              return {
                ...current,
                [selectedSection.id]: next,
              };
            })
          }
        />,
      );

      if (isExpanded) {
        children.push(
          <ReviewFileBody
            key={`review-file-body:${file.id}`}
            file={file}
            sectionTitle={selectedSection.title}
            highlightedFile={fileHighlights}
            pendingSelection={pendingCommentSelection}
            selectedTarget={activeCommentTarget}
            viewportWidth={Math.max(width, 280)}
            onPressLine={(_line, availableLines, lineIndex) => {
              if (pendingCommentSelection) {
                if (
                  pendingCommentSelection.sectionTitle === selectedSection.title &&
                  pendingCommentSelection.filePath === file.path
                ) {
                  setReviewCommentTarget(
                    buildReviewCommentTarget(
                      {
                        sectionTitle: pendingCommentSelection.sectionTitle,
                        filePath: pendingCommentSelection.filePath,
                        lines: pendingCommentSelection.lines,
                      },
                      pendingCommentSelection.anchorIndex,
                      lineIndex,
                    ),
                  );
                  setPendingCommentSelection(null);
                  return;
                }

                clearReviewCommentTarget();
                setPendingCommentSelection({
                  sectionTitle: selectedSection.title,
                  filePath: file.path,
                  lines: availableLines,
                  anchorIndex: lineIndex,
                });
                return;
              }

              setReviewCommentTarget({
                sectionTitle: selectedSection.title,
                filePath: file.path,
                lines: availableLines,
                startIndex: lineIndex,
                endIndex: lineIndex,
              });
              if (environmentId && threadId) {
                router.push({
                  pathname: "/threads/[environmentId]/[threadId]/review-comment",
                  params: { environmentId, threadId },
                });
              }
            }}
            onStartRangeSelection={(_line, availableLines, lineIndex) => {
              clearReviewCommentTarget();
              setPendingCommentSelection({
                sectionTitle: selectedSection.title,
                filePath: file.path,
                lines: availableLines,
                anchorIndex: lineIndex,
              });
            }}
          />,
        );
      }
    });

    return { children, stickyHeaderIndices };
  }, [
    activeCommentTarget,
    error,
    expandedFileIds,
    highlightedFileByKey,
    pendingCommentSelection,
    parsedDiff,
    router,
    selectedSection,
    selectedTheme,
    threadId,
    width,
    environmentId,
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
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
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
                  </>
                ) : (
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
              onPress={() => setSelectedSectionId(section.id)}
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
        <ScrollView
          contentInsetAdjustmentBehavior="never"
          contentInset={{ top: topContentInset }}
          contentOffset={{ x: 0, y: -topContentInset }}
          scrollIndicatorInsets={{ top: topContentInset }}
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          stickyHeaderIndices={reviewContent.stickyHeaderIndices}
          stickyHeaderHiddenOnScroll={false}
          contentContainerStyle={{
            paddingTop: REVIEW_HEADER_SPACING,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
        >
          {reviewContent.children}
        </ScrollView>

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
