import { EnvironmentId, ThreadId, type OrchestrationCheckpointSummary } from "@t3tools/contracts";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useLocalSearchParams, useRouter } from "expo-router";
import Stack from "expo-router/stack";
import { SymbolView } from "expo-symbols";
import {
  memo,
  type ReactElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  ScrollView,
  Text as NativeText,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { getEnvironmentClient } from "../../state/environment-session-registry";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  getCachedReviewParsedDiff,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  updateReviewExpandedFileIds,
  updateReviewRevealedLargeFileIds,
  updateReviewViewedFileIds,
  useReviewCacheForThread,
} from "./reviewState";
import {
  buildReviewListItems,
  getReadyReviewCheckpoints,
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReviewFilePreviewState,
  getReviewSectionIdForCheckpoint,
  type ReviewListItem,
  type ReviewParsedDiff,
  type ReviewRenderableFile,
  type ReviewRenderableLineRow,
  type ReviewRenderableRow,
} from "./reviewModel";
import {
  clearReviewHighlightFileCache,
  getCachedHighlightedReviewFile,
  streamHighlightReviewFile,
  type ReviewDiffTheme,
  type ReviewHighlightedFile,
  type ReviewHighlightedToken,
} from "./shikiReviewHighlighter";
import {
  buildReviewCommentTarget,
  clearReviewCommentTarget,
  countReviewCommentContexts,
  formatReviewSelectedRangeLabel,
  getReviewUnifiedLineNumber,
  setReviewCommentTarget,
  type ReviewCommentTarget,
  useReviewCommentTarget,
} from "./reviewCommentSelection";
import {
  changeTone,
  DiffTokenText,
  REVIEW_DIFF_LINE_HEIGHT,
  REVIEW_MONO_FONT_FAMILY,
  ReviewChangeBar,
} from "./reviewDiffRendering";
import { markReviewEvent, measureReviewWork } from "./reviewPerf";
import { useReviewHighlighterStatus } from "./ReviewHighlighterProvider";

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
const REVIEW_HEADER_SPACING = 0;
const REVIEW_CHANGE_BAR_WIDTH = 5;
const REVIEW_MIN_LINE_NUMBER_WIDTH = 27;
const REVIEW_LINE_NUMBER_DIGIT_WIDTH_ESTIMATE = 8;
const REVIEW_LINE_NUMBER_HORIZONTAL_PADDING = 6;
const REVIEW_CHARACTER_WIDTH_ESTIMATE = 8.4;
const REVIEW_MAX_CONTENT_WIDTH = 4_800;
const REVIEW_HUNK_ROW_HEIGHT = 35;
const REVIEW_FILE_HEADER_HEIGHT = 43;
const REVIEW_SUPPRESSED_ROW_HEIGHT = 92;
const loggedMissingReviewTokenKeys = new Set<string>();

function waitForReviewDelay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isReviewDiffDebugLoggingEnabled(): boolean {
  return typeof __DEV__ !== "undefined" ? __DEV__ : false;
}

function logReviewDiffDiagnostic(message: string, details?: Record<string, unknown>): void {
  if (!isReviewDiffDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-sheet] ${message}`, details);
    return;
  }

  console.log(`[review-sheet] ${message}`);
}

function getFileHeaderChrome(changeType: ReviewRenderableFile["changeType"]): {
  readonly dot: string;
} {
  switch (changeType) {
    case "new":
      return {
        dot: "bg-emerald-400",
      };
    case "deleted":
      return {
        dot: "bg-rose-400",
      };
    case "rename-pure":
      return {
        dot: "bg-amber-400",
      };
    case "rename-changed":
      return {
        dot: "bg-sky-400",
      };
    default:
      return {
        dot: "bg-sky-400",
      };
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

function computeReviewFileContentWidth(
  rows: ReadonlyArray<ReviewRenderableRow>,
  viewportWidth: number,
  gutterWidth: number,
): number {
  let maxTextLength = 0;

  rows.forEach((row) => {
    if (row.kind === "hunk") {
      maxTextLength = Math.max(
        maxTextLength,
        row.header.length + (row.context ? row.context.length + 1 : 0),
      );
      return;
    }

    maxTextLength = Math.max(maxTextLength, row.content.length);
  });

  return Math.max(
    Math.max(0, viewportWidth - gutterWidth),
    Math.min(
      REVIEW_MAX_CONTENT_WIDTH,
      Math.ceil(48 + maxTextLength * REVIEW_CHARACTER_WIDTH_ESTIMATE),
    ),
  );
}

function computeReviewFileGutterWidth(rows: ReadonlyArray<ReviewRenderableRow>): number {
  let maxLineNumber = 0;

  rows.forEach((row) => {
    if (row.kind !== "line") {
      return;
    }

    maxLineNumber = Math.max(maxLineNumber, row.oldLineNumber ?? 0, row.newLineNumber ?? 0);
  });

  const digitCount = Math.max(1, String(maxLineNumber).length);
  const lineNumberWidth = Math.max(
    REVIEW_MIN_LINE_NUMBER_WIDTH,
    digitCount * REVIEW_LINE_NUMBER_DIGIT_WIDTH_ESTIMATE + REVIEW_LINE_NUMBER_HORIZONTAL_PADDING,
  );

  return REVIEW_CHANGE_BAR_WIDTH + lineNumberWidth;
}

function getDefaultExpandedFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
): ReadonlyArray<string> {
  return files.map((file) => file.id);
}

function getValidReviewExpandedFileIds(
  files: ReadonlyArray<ReviewRenderableFile>,
  cachedExpandedFileIds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (cachedExpandedFileIds === undefined) {
    return getDefaultExpandedFileIds(files);
  }

  const fileIdSet = new Set(files.map((file) => file.id));
  return cachedExpandedFileIds.filter((id) => fileIdSet.has(id));
}

function getHighlightedTokensForLine(
  line: ReviewRenderableLineRow,
  highlightedFile: ReviewHighlightedFile | null,
): ReadonlyArray<ReviewHighlightedToken> | null {
  if (!highlightedFile) {
    return null;
  }

  if (line.additionTokenIndex !== null) {
    return highlightedFile.additionLines[line.additionTokenIndex] ?? null;
  }

  if (line.deletionTokenIndex !== null) {
    return highlightedFile.deletionLines[line.deletionTokenIndex] ?? null;
  }

  return null;
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
      style={{
        height: REVIEW_DIFF_LINE_HEIGHT,
        width: props.viewportWidth,
        overflow: "hidden",
      }}
    >
      <View className="min-w-0 flex-1 shrink-0 px-1 py-1" style={{ width: props.viewportWidth }}>
        <DiffTokenText
          tokens={props.tokens}
          fallback={props.line.content}
          change={props.line.change}
        />
      </View>
    </Pressable>
  );
});

const ReviewLineGutter = memo(function ReviewLineGutter(props: {
  readonly change: ReviewRenderableLineRow["change"];
  readonly gutterWidth: number;
  readonly lineNumber: number | null;
}) {
  const lineNumberWidth = Math.max(0, props.gutterWidth - REVIEW_CHANGE_BAR_WIDTH);

  return (
    <View className={cn("flex-row", changeTone(props.change))} style={{ width: props.gutterWidth }}>
      <ReviewChangeBar change={props.change} />
      <Text
        className="py-1 pr-1 text-right text-[11px] font-t3-medium text-foreground-muted"
        style={[{ fontFamily: REVIEW_MONO_FONT_FAMILY }, { width: lineNumberWidth }]}
      >
        {props.lineNumber ?? ""}
      </Text>
    </View>
  );
});

const ReviewHunkGutter = memo(function ReviewHunkGutter(props: { readonly gutterWidth: number }) {
  return (
    <View
      className="border-b border-border/60 bg-sky-500/10"
      style={{ width: props.gutterWidth }}
    />
  );
});

const ReviewFileCard = memo(function ReviewFileCard(props: {
  readonly file: ReviewRenderableFile;
  readonly fileId: string;
  readonly expanded: boolean;
  readonly viewed: boolean;
  readonly viewportWidth: number;
  readonly onToggleFile: (fileId: string) => void;
  readonly onToggleViewed: (fileId: string) => void;
}) {
  const { expanded, file, fileId, onToggleFile, onToggleViewed, viewed, viewportWidth } = props;
  const chrome = getFileHeaderChrome(file.changeType);
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const handleToggleFile = useCallback(() => {
    onToggleFile(fileId);
  }, [fileId, onToggleFile]);
  const handleToggleViewed = useCallback(() => {
    onToggleViewed(fileId);
  }, [fileId, onToggleViewed]);

  return (
    <View
      className="border-b border-border bg-card"
      style={{ height: REVIEW_FILE_HEADER_HEIGHT, overflow: "hidden", width: viewportWidth }}
    >
      <View className="min-h-[42px] flex-row items-center gap-1.5 px-2">
        <Pressable
          className="size-9 items-center justify-center"
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse file" : "Expand file"}
          hitSlop={{ bottom: 8, left: 8, right: 8, top: 8 }}
          onTouchEnd={handleToggleFile}
        >
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={13}
            tintColor={iconColor}
            type="monochrome"
          />
        </Pressable>
        <Pressable
          className="min-w-0 flex-1 flex-row items-center gap-2 py-2"
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse file" : "Expand file"}
          onTouchEnd={handleToggleFile}
        >
          <View className={cn("size-2.5 rounded-full", chrome.dot)} />
          <View className="min-w-0 flex-1">
            <Text
              className="font-mono text-[13px] leading-[18px] text-foreground"
              numberOfLines={1}
            >
              {file.path}
            </Text>
            {file.previousPath && file.previousPath !== file.path ? (
              <Text
                className="font-mono text-[10px] leading-[14px] text-foreground-muted"
                numberOfLines={1}
              >
                {file.previousPath}
              </Text>
            ) : null}
          </View>
        </Pressable>
        <View className="flex-row items-center justify-end gap-1.5">
          <Text className="font-mono text-[12px] font-t3-bold text-rose-400">
            -{file.deletions}
          </Text>
          <Text className="font-mono text-[12px] font-t3-bold text-emerald-400">
            +{file.additions}
          </Text>
          <Pressable
            className="ml-0.5 min-h-[40px] min-w-[82px] flex-row items-center justify-center gap-1.5 px-1.5"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: viewed }}
            accessibilityLabel={viewed ? "Mark file as unviewed" : "Mark file as viewed"}
            hitSlop={{ bottom: 8, left: 4, right: 8, top: 8 }}
            onTouchEnd={handleToggleViewed}
          >
            <View
              className={cn(
                "size-[18px] items-center justify-center rounded border",
                viewed ? "border-sky-500 bg-sky-500" : "border-icon-muted",
              )}
            >
              {viewed ? (
                <SymbolView name="checkmark" size={11} tintColor="#ffffff" type="monochrome" />
              ) : null}
            </View>
            <Text
              className={cn(
                "text-[12px] font-t3-medium",
                viewed ? "text-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              Viewed
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
});

const ReviewFileSuppressedBody = memo(function ReviewFileSuppressedBody(props: {
  readonly message: string;
  readonly actionLabel?: string | null;
  readonly fileId: string;
  readonly viewportWidth: number;
  readonly onLoadDiffFile?: (fileId: string) => void;
}) {
  return (
    <View
      className="gap-2 border-b border-border bg-card px-4 py-3"
      style={{
        height: REVIEW_SUPPRESSED_ROW_HEIGHT,
        overflow: "hidden",
        width: props.viewportWidth,
      }}
    >
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

const ReviewHunkRow = memo(function ReviewHunkRow(props: {
  readonly header: string;
  readonly context: string | null;
  readonly viewportWidth: number;
}) {
  return (
    <View
      className="border-b border-border/60 bg-sky-500/10 py-2"
      style={{ height: REVIEW_HUNK_ROW_HEIGHT, width: props.viewportWidth, overflow: "hidden" }}
    >
      <Text
        className="px-2 font-mono text-[12px] leading-[18px] text-sky-700 dark:text-sky-300"
        numberOfLines={1}
      >
        {props.header}
        {props.context ? ` ${props.context}` : ""}
      </Text>
    </View>
  );
});

const ReviewCodePanRow = memo(function ReviewCodePanRow(props: {
  readonly contentWidth: number;
  readonly horizontalOffset: SharedValue<number>;
  readonly gutterWidth?: number;
  readonly viewportWidth: number;
  readonly leftGutter?: ReactElement;
  readonly children: ReactElement;
}) {
  const {
    children,
    contentWidth,
    gutterWidth = 0,
    horizontalOffset,
    leftGutter,
    viewportWidth,
  } = props;
  const dragStartOffset = useSharedValue(0);
  const visibleContentWidth = leftGutter ? viewportWidth - gutterWidth : viewportWidth;
  const maxOffset = Math.max(0, contentWidth - visibleContentWidth);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-8, 8])
        .failOffsetY([-10, 10])
        .onBegin(() => {
          dragStartOffset.value = horizontalOffset.value;
        })
        .onUpdate((event) => {
          "worklet";
          const nextOffset = dragStartOffset.value - event.translationX;
          horizontalOffset.value = Math.min(maxOffset, Math.max(0, nextOffset));
        }),
    [dragStartOffset, horizontalOffset, maxOffset],
  );

  const contentStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: -horizontalOffset.value }],
    }),
    [horizontalOffset],
  );

  return (
    <GestureDetector gesture={panGesture}>
      <View style={{ flexDirection: "row", overflow: "hidden", width: viewportWidth }}>
        {leftGutter ?? null}
        <View style={{ flex: 1, overflow: "hidden" }}>
          <Animated.View style={[{ width: contentWidth }, contentStyle]}>{children}</Animated.View>
        </View>
      </View>
    </GestureDetector>
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
    environmentId: EnvironmentId;
    threadId: ThreadId;
  }>();
  const { draftMessage } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const selectedThread = useSelectedThreadDetail();
  const [loadingTurnIds, setLoadingTurnIds] = useState<Record<string, boolean>>({});
  const [loadingGitDiffs, setLoadingGitDiffs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] =
    useState<PendingCommentSelection | null>(null);
  const [highlightedFilesById, setHighlightedFilesById] = useState<
    Record<string, ReviewHighlightedFile | null>
  >({});
  const deferredHighlightedFilesById = useDeferredValue(highlightedFilesById);
  const [localExpandedFileIdsBySection, setLocalExpandedFileIdsBySection] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  const [localViewedFileIdsBySection, setLocalViewedFileIdsBySection] = useState<
    Record<string, ReadonlyArray<string>>
  >({});
  const activeCommentTarget = useReviewCommentTarget();
  const selectedTheme = (colorScheme === "dark" ? "dark" : "light") satisfies ReviewDiffTheme;
  const reviewHighlighter = useReviewHighlighterStatus();
  const highlightRunIdRef = useRef(0);
  const highlightableFilesRef = useRef<ReadonlyArray<ReviewRenderableFile>>([]);
  const horizontalOffsetByFileIdRef = useRef<Map<string, SharedValue<number>>>(new Map());
  const { selectedThreadCwd } = useSelectedThreadWorktree();

  const cwd = selectedThreadCwd;
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
      measureReviewWork("parse-diff", () =>
        getCachedReviewParsedDiff({
          threadKey: reviewCache.threadKey,
          sectionId: selectedSection?.id ?? null,
          diff: selectedSection?.diff,
        }),
      ),
    [reviewCache.threadKey, selectedSection?.diff, selectedSection?.id],
  );
  const headerDiffSummary = useMemo(() => formatHeaderDiffSummary(parsedDiff), [parsedDiff]);
  const pendingReviewCommentCount = useMemo(
    () => countReviewCommentContexts(draftMessage),
    [draftMessage],
  );
  const viewportWidth = Math.max(width, 280);

  useEffect(() => {
    if (!selectedSection?.id || parsedDiff.kind !== "files") {
      return;
    }

    setLocalExpandedFileIdsBySection((current) => {
      if (current[selectedSection.id] !== undefined) {
        return current;
      }

      return {
        ...current,
        [selectedSection.id]: getValidReviewExpandedFileIds(
          parsedDiff.files,
          reviewCache.expandedFileIdsBySection[selectedSection.id],
        ),
      };
    });

    setLocalViewedFileIdsBySection((current) => {
      if (current[selectedSection.id] !== undefined) {
        return current;
      }

      return {
        ...current,
        [selectedSection.id]: reviewCache.viewedFileIdsBySection[selectedSection.id] ?? [],
      };
    });
  }, [
    parsedDiff,
    reviewCache.expandedFileIdsBySection,
    reviewCache.viewedFileIdsBySection,
    selectedSection?.id,
  ]);

  const expandedFileIds = useMemo(
    () =>
      selectedSection?.id && parsedDiff.kind === "files"
        ? getValidReviewExpandedFileIds(
            parsedDiff.files,
            localExpandedFileIdsBySection[selectedSection.id],
          )
        : [],
    [localExpandedFileIdsBySection, parsedDiff, selectedSection?.id],
  );
  const revealedLargeFileIds = useMemo(
    () =>
      selectedSection?.id
        ? (reviewCache.revealedLargeFileIdsBySection[selectedSection.id] ?? [])
        : [],
    [reviewCache.revealedLargeFileIdsBySection, selectedSection?.id],
  );
  const viewedFileIds = useMemo(
    () => (selectedSection?.id ? (localViewedFileIdsBySection[selectedSection.id] ?? []) : []),
    [localViewedFileIdsBySection, selectedSection?.id],
  );
  const viewedFileIdSet = useMemo(() => new Set(viewedFileIds), [viewedFileIds]);
  const reviewListItems = useMemo(
    () =>
      selectedSection && parsedDiff.kind === "files"
        ? measureReviewWork("build-list-items", () =>
            buildReviewListItems({
              files: parsedDiff.files,
              expandedFileIds,
              revealedLargeFileIds,
            }),
          )
        : [],
    [expandedFileIds, parsedDiff, revealedLargeFileIds, selectedSection],
  );
  const reviewLineRowsByFileId = useMemo(() => {
    if (parsedDiff.kind !== "files") {
      return new Map<string, ReadonlyArray<ReviewRenderableLineRow>>();
    }

    return measureReviewWork(
      "index-line-rows",
      () =>
        new Map(
          parsedDiff.files.map((file) => [
            file.id,
            file.rows.filter((row): row is ReviewRenderableLineRow => row.kind === "line"),
          ]),
        ),
    );
  }, [parsedDiff]);
  const reviewContentWidthByFileId = useMemo(() => {
    if (parsedDiff.kind !== "files") {
      return new Map<string, number>();
    }

    return measureReviewWork(
      "measure-file-widths",
      () =>
        new Map(
          parsedDiff.files.map((file) => [
            file.id,
            computeReviewFileContentWidth(
              file.rows,
              viewportWidth,
              computeReviewFileGutterWidth(file.rows),
            ),
          ]),
        ),
    );
  }, [parsedDiff, viewportWidth]);
  const reviewGutterWidthByFileId = useMemo(() => {
    if (parsedDiff.kind !== "files") {
      return new Map<string, number>();
    }

    return new Map(
      parsedDiff.files.map((file) => [file.id, computeReviewFileGutterWidth(file.rows)]),
    );
  }, [parsedDiff]);
  const getReviewFileHorizontalOffset = useCallback((fileId: string) => {
    let offset = horizontalOffsetByFileIdRef.current.get(fileId);
    if (!offset) {
      offset = makeMutable(0);
      horizontalOffsetByFileIdRef.current.set(fileId, offset);
    }

    return offset;
  }, []);
  useEffect(() => {
    const knownFileIds =
      parsedDiff.kind === "files" ? new Set(parsedDiff.files.map((file) => file.id)) : new Set();

    horizontalOffsetByFileIdRef.current.forEach((offset, fileId) => {
      if (!knownFileIds.has(fileId)) {
        horizontalOffsetByFileIdRef.current.delete(fileId);
        return;
      }

      const contentWidth = reviewContentWidthByFileId.get(fileId) ?? viewportWidth;
      const gutterWidth = reviewGutterWidthByFileId.get(fileId) ?? 0;
      offset.value = Math.min(
        offset.value,
        Math.max(0, contentWidth - (viewportWidth - gutterWidth)),
      );
    });
  }, [parsedDiff, reviewContentWidthByFileId, reviewGutterWidthByFileId, viewportWidth]);
  const highlightableFiles = useMemo(() => {
    if (parsedDiff.kind !== "files") {
      return [] as ReadonlyArray<ReviewRenderableFile>;
    }

    const expandedFileIdSet = new Set(expandedFileIds);
    const revealedLargeFileIdSet = new Set(revealedLargeFileIds);

    return parsedDiff.files.filter((file) => {
      if (!expandedFileIdSet.has(file.id)) {
        return false;
      }

      const previewState = getReviewFilePreviewState(file);
      return (
        previewState.kind === "render" ||
        (previewState.reason === "large" && revealedLargeFileIdSet.has(file.id))
      );
    });
  }, [expandedFileIds, parsedDiff, revealedLargeFileIds]);
  const highlightableFilesKey = useMemo(
    () => highlightableFiles.map((file) => `${file.id}:${file.cacheKey}`).join("\n"),
    [highlightableFiles],
  );
  useEffect(() => {
    highlightableFilesRef.current = highlightableFiles;
  }, [highlightableFiles]);
  const loadGitDiffs = useCallback(async () => {
    if (!cwd) {
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
      if (!threadId) {
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
      const validIds = getValidReviewExpandedFileIds(parsedDiff.files, existing);
      if (
        existing !== undefined &&
        validIds.length === existing.length &&
        validIds.every((id, index) => id === existing[index])
      ) {
        return existing;
      }
      return validIds;
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

  useEffect(() => {
    setHighlightedFilesById({});
    highlightRunIdRef.current += 1;
    clearReviewHighlightFileCache();
    loggedMissingReviewTokenKeys.clear();
    logReviewDiffDiagnostic("reset highlighted files", {
      selectedSectionId: selectedSection?.id ?? null,
      selectedTheme,
    });
  }, [selectedSection?.id, selectedTheme]);

  useEffect(() => {
    if (parsedDiff.kind !== "files") {
      return;
    }

    markReviewEvent("parsed-diff-ready", {
      sectionId: selectedSection?.id ?? null,
      fileCount: parsedDiff.fileCount,
      additions: parsedDiff.additions,
      deletions: parsedDiff.deletions,
      renderedItems: reviewListItems.length,
    });
    logReviewDiffDiagnostic("parsed diff files", {
      selectedSectionId: selectedSection?.id ?? null,
      fileCount: parsedDiff.fileCount,
      renderableFileCount: parsedDiff.files.length,
    });
  }, [parsedDiff, reviewListItems.length, selectedSection?.id]);

  useEffect(() => {
    const files = highlightableFilesRef.current;
    if (files.length === 0) {
      logReviewDiffDiagnostic("no highlightable files", {
        selectedSectionId: selectedSection?.id ?? null,
        parsedDiffKind: parsedDiff.kind,
        requestedFileCount: 0,
      });
      return;
    }

    if (reviewHighlighter.status !== "ready") {
      logReviewDiffDiagnostic("waiting for highlighter provider", {
        selectedSectionId: selectedSection?.id ?? null,
        status: reviewHighlighter.status,
        error: reviewHighlighter.error,
      });
      return;
    }

    const runId = highlightRunIdRef.current;
    let cancelled = false;

    logReviewDiffDiagnostic("streaming file highlights", {
      selectedSectionId: selectedSection?.id ?? null,
      fileCount: files.length,
    });

    void (async () => {
      for (const file of files) {
        if (cancelled || runId !== highlightRunIdRef.current) {
          return;
        }

        const cached = getCachedHighlightedReviewFile(file, selectedTheme);
        if (cached) {
          setHighlightedFilesById((current) =>
            current[file.id] === cached ? current : { ...current, [file.id]: cached },
          );
          continue;
        }

        logReviewDiffDiagnostic("requesting highlighted file", {
          fileId: file.id,
          filePath: file.path,
          theme: selectedTheme,
        });

        try {
          const highlightStartedAt = performance.now();
          const result = await streamHighlightReviewFile(file, selectedTheme, (progress) => {
            if (cancelled || runId !== highlightRunIdRef.current) {
              return;
            }

            if (!progress.complete) {
              return;
            }

            logReviewDiffDiagnostic("received streamed highlighted file", {
              fileId: file.id,
              filePath: file.path,
              highlightedLineCount: progress.highlightedLineCount,
              durationMs: Math.round(performance.now() - highlightStartedAt),
            });
          });

          if (cancelled || runId !== highlightRunIdRef.current) {
            return;
          }

          logReviewDiffDiagnostic("received highlighted file", {
            fileId: file.id,
            filePath: file.path,
            additionLines: result.additionLines.length,
            deletionLines: result.deletionLines.length,
          });
          setHighlightedFilesById((current) =>
            current[file.id] === result ? current : { ...current, [file.id]: result },
          );
        } catch (error) {
          logReviewDiffDiagnostic("highlight request failed", {
            fileId: file.id,
            filePath: file.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        await waitForReviewDelay(0);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    highlightableFilesKey,
    parsedDiff.kind,
    reviewHighlighter.error,
    reviewHighlighter.status,
    selectedSection?.id,
    selectedTheme,
  ]);

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
      if (!selectedSection?.id || parsedDiff.kind !== "files") {
        return;
      }

      const sectionId = selectedSection.id;

      setLocalExpandedFileIdsBySection((current) => {
        const currentIds = getValidReviewExpandedFileIds(parsedDiff.files, current[sectionId]);
        const nextIds = currentIds.includes(fileId)
          ? currentIds.filter((id) => id !== fileId)
          : [...currentIds, fileId];

        return {
          ...current,
          [sectionId]: nextIds,
        };
      });

      if (reviewCache.threadKey) {
        updateReviewExpandedFileIds(reviewCache.threadKey, sectionId, (existing) => {
          const currentIds = getValidReviewExpandedFileIds(parsedDiff.files, existing);
          return currentIds.includes(fileId)
            ? currentIds.filter((id) => id !== fileId)
            : [...currentIds, fileId];
        });
      }
    },
    [parsedDiff, reviewCache.threadKey, selectedSection?.id],
  );

  const handleToggleViewedFile = useCallback(
    (fileId: string) => {
      if (!selectedSection?.id) {
        return;
      }

      const sectionId = selectedSection.id;

      setLocalViewedFileIdsBySection((current) => {
        const currentIds = current[sectionId] ?? [];
        const nextIds = currentIds.includes(fileId)
          ? currentIds.filter((id) => id !== fileId)
          : [...currentIds, fileId];

        return {
          ...current,
          [sectionId]: nextIds,
        };
      });

      if (reviewCache.threadKey) {
        updateReviewViewedFileIds(reviewCache.threadKey, sectionId, (existing) => {
          const currentIds = existing ?? [];
          return currentIds.includes(fileId)
            ? currentIds.filter((id) => id !== fileId)
            : [...currentIds, fileId];
        });
      }
    },
    [reviewCache.threadKey, selectedSection?.id],
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

  const renderReviewListItem = useCallback(
    ({ item }: ListRenderItemInfo<ReviewListItem>) => {
      if (!selectedSection) {
        return null;
      }

      let renderedItem: ReactElement | null = null;
      switch (item.kind) {
        case "file-header":
          renderedItem = (
            <ReviewFileCard
              file={item.file}
              fileId={item.fileId}
              expanded={item.expanded}
              viewed={viewedFileIdSet.has(item.fileId)}
              viewportWidth={viewportWidth}
              onToggleFile={handleToggleExpandedFile}
              onToggleViewed={handleToggleViewedFile}
            />
          );
          break;
        case "file-suppressed":
          renderedItem = (
            <ReviewFileSuppressedBody
              message={item.message}
              actionLabel={item.actionLabel}
              fileId={item.fileId}
              viewportWidth={viewportWidth}
              onLoadDiffFile={handleRevealLargeDiff}
            />
          );
          break;
        case "hunk": {
          const contentWidth = reviewContentWidthByFileId.get(item.fileId) ?? viewportWidth;
          const gutterWidth = reviewGutterWidthByFileId.get(item.fileId) ?? 0;

          renderedItem = (
            <ReviewCodePanRow
              key={item.id}
              contentWidth={contentWidth}
              gutterWidth={gutterWidth}
              horizontalOffset={getReviewFileHorizontalOffset(item.fileId)}
              leftGutter={<ReviewHunkGutter gutterWidth={gutterWidth} />}
              viewportWidth={viewportWidth}
            >
              <ReviewHunkRow
                header={item.row.header}
                context={item.row.context}
                viewportWidth={contentWidth}
              />
            </ReviewCodePanRow>
          );
          break;
        }
        case "line": {
          const fileLineRows = reviewLineRowsByFileId.get(item.file.id) ?? [];
          const pendingSelectionForFile =
            pendingCommentSelection &&
            pendingCommentSelection.sectionTitle === selectedSection.title &&
            pendingCommentSelection.filePath === item.file.path
              ? pendingCommentSelection
              : null;
          const selectedTargetForFile =
            activeCommentTarget &&
            activeCommentTarget.sectionTitle === selectedSection.title &&
            activeCommentTarget.filePath === item.file.path
              ? activeCommentTarget
              : null;
          const highlightedFile =
            deferredHighlightedFilesById[item.file.id] ??
            getCachedHighlightedReviewFile(item.file, selectedTheme) ??
            null;
          const contentWidth = reviewContentWidthByFileId.get(item.fileId) ?? viewportWidth;
          const gutterWidth = reviewGutterWidthByFileId.get(item.fileId) ?? 0;

          if (highlightedFile === null) {
            const missingTokenKey = `${selectedSection.id}:${item.file.id}`;
            if (!loggedMissingReviewTokenKeys.has(missingTokenKey)) {
              loggedMissingReviewTokenKeys.add(missingTokenKey);
              logReviewDiffDiagnostic("rendering file without tokens", {
                sectionId: selectedSection.id,
                fileId: item.file.id,
                filePath: item.file.path,
                highlightedFileKnownInState:
                  deferredHighlightedFilesById[item.file.id] !== undefined,
              });
            }
          }

          const selectionState =
            pendingSelectionForFile?.anchorIndex === item.lineIndex
              ? ("anchor" as const)
              : selectedTargetForFile &&
                  item.lineIndex >= selectedTargetForFile.startIndex &&
                  item.lineIndex <= selectedTargetForFile.endIndex
                ? ("selected" as const)
                : null;

          renderedItem = (
            <ReviewCodePanRow
              key={item.id}
              contentWidth={contentWidth}
              gutterWidth={gutterWidth}
              horizontalOffset={getReviewFileHorizontalOffset(item.fileId)}
              leftGutter={
                <ReviewLineGutter
                  change={item.row.change}
                  gutterWidth={gutterWidth}
                  lineNumber={getReviewUnifiedLineNumber(item.row)}
                />
              }
              viewportWidth={viewportWidth}
            >
              <ReviewLineRow
                line={item.row}
                tokens={getHighlightedTokensForLine(item.row, highlightedFile)}
                viewportWidth={contentWidth}
                selectionState={selectionState}
                onComment={() =>
                  handlePressLine({
                    sectionTitle: selectedSection.title,
                    filePath: item.file.path,
                    lines: fileLineRows,
                    lineIndex: item.lineIndex,
                  })
                }
                onStartRangeSelection={() =>
                  handleStartRangeSelection({
                    sectionTitle: selectedSection.title,
                    filePath: item.file.path,
                    lines: fileLineRows,
                    lineIndex: item.lineIndex,
                  })
                }
              />
            </ReviewCodePanRow>
          );
          break;
        }
      }

      return renderedItem;
    },
    [
      activeCommentTarget,
      handlePressLine,
      handleRevealLargeDiff,
      handleStartRangeSelection,
      handleToggleExpandedFile,
      handleToggleViewedFile,
      getReviewFileHorizontalOffset,
      deferredHighlightedFilesById,
      pendingCommentSelection,
      reviewContentWidthByFileId,
      reviewGutterWidthByFileId,
      reviewLineRowsByFileId,
      selectedSection,
      selectedTheme,
      viewedFileIdSet,
      viewportWidth,
    ],
  );

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
          <FlatList
            style={{ flex: 1, width: viewportWidth }}
            contentInsetAdjustmentBehavior="never"
            data={reviewListItems}
            renderItem={renderReviewListItem}
            keyExtractor={(item) => item.id}
            initialNumToRender={20}
            maxToRenderPerBatch={20}
            updateCellsBatchingPeriod={16}
            windowSize={5}
            removeClippedSubviews={false}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={listHeader}
            contentContainerStyle={{
              paddingTop: topContentInset + REVIEW_HEADER_SPACING,
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
