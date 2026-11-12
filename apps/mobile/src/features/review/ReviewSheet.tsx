import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { LegendList } from "@legendapp/list/react-native";
import { resolveSelectedReviewFileId } from "./reviewPaneSelection";
import { WorkingChangesReview } from "./WorkingChangesReview";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { useReviewHeaderPresentation } from "./useReviewHeaderPresentation";
import {
  type Ref,
  useImperativeHandle,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { Inspector } from "../layout/AdaptiveWorkspaceLayout";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useReviewCacheForThread } from "./reviewState";
import {
  isNativeReviewDiffDrawEvent,
  type NativeReviewDiffViewHandle,
  resolveNativeReviewDiffView,
} from "../diffs/nativeReviewDiffSurface";
import { NATIVE_REVIEW_DIFF_CONTENT_WIDTH } from "./nativeReviewDiffAdapter";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useReviewDiffData } from "./useReviewDiffData";
import { useReviewDiffPrewarming } from "./useReviewDiffPrewarming";
import { useReviewFileVisibility } from "./reviewFileVisibility";
import { useReviewSections } from "./useReviewSections";
import { useNativeReviewDiffBridge } from "./useNativeReviewDiffBridge";
import { useReviewCommentSelectionController } from "./useReviewCommentSelectionController";
import { resolveReviewAvailability } from "./reviewAvailability";
import { ReviewComparisonPicker } from "./ReviewComparisonPicker";
import { ReviewFileTree } from "./ReviewFileTree";
import { selectReviewFileDiff } from "./reviewPaneSelection";
import {
  readThreadReviewSelection,
  rememberThreadReviewSelection,
  workspaceThreadMemoryKey,
} from "../layout/workspace/workspacePaneMemory";
import { reportShowcaseSceneRendered } from "../showcase/showcaseRenderSignal";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

export function ReviewHeader(
  props: Parameters<typeof useReviewHeaderPresentation>[0] & {
    readonly iconColor?: string;
    readonly onReturnToThread: () => void;
    readonly showGitMenu?: boolean;
  },
) {
  const presentation = useReviewHeaderPresentation(props);
  return (
    <AppBar
      title={presentation.title}
      subtitle={presentation.subtitle}
      onBack={props.onReturnToThread}
      hideBottomBorder
      backInSplitView={{ accessibilityLabel: "Back to chat", icon: "chevron.left" }}
      menus={[
        ...(presentation.gitMenu && props.showGitMenu !== false ? [presentation.gitMenu] : []),
        ...(presentation.refreshAction
          ? [
              {
                title: "Git actions",
                icon: "ellipsis" as const,
                items: [presentation.refreshAction],
              },
            ]
          : []),
      ]}
    />
  );
}

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

const ReviewNotice = function ReviewNotice(props: { readonly notice: string }) {
  return (
    <View
      className={cn(
        "bg-warning px-4 py-3",
        Platform.OS === "android" ? "m-2 rounded-[20px]" : "border-b border-warning-border",
      )}
    >
      <Text className="text-xs font-t3-bold uppercase text-warning-foreground">Partial diff</Text>
      <Text className="text-xs leading-normal text-warning-foreground">{props.notice}</Text>
    </View>
  );
};

function ReviewSelectionActionBar(props: {
  readonly bottomInset: number;
  readonly title: string | null;
  readonly onOpenComment: (() => void) | null;
  readonly onClear: () => void;
}) {
  if (!props.title) {
    return null;
  }

  const content = (
    <>
      <SymbolView
        name={props.onOpenComment ? "text.bubble" : "line.3.horizontal.decrease.circle"}
        size={16}
        tintColorClassName="accent-primary-foreground"
        type="monochrome"
      />
      <Text className="text-base font-t3-bold text-primary-foreground">{props.title}</Text>
    </>
  );

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
      {props.onOpenComment ? (
        <Pressable
          className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-primary px-5"
          onPress={props.onOpenComment}
        >
          {content}
        </Pressable>
      ) : (
        <View className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-primary px-5">
          {content}
        </View>
      )}

      <Pressable
        className="h-12 w-12 items-center justify-center rounded-full bg-primary"
        onPress={props.onClear}
      >
        <SymbolView
          name="xmark"
          size={16}
          tintColorClassName="accent-primary-foreground"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

interface ReviewNavigatorFile {
  readonly id: string;
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

const ReviewFileNavigatorRow = function ReviewFileNavigatorRow(props: {
  readonly file: ReviewNavigatorFile;
  readonly selected: boolean;
  readonly onSelectFile: (fileId: string | null) => void;
}) {
  const { file, selected, onSelectFile } = props;
  const handlePress = () => {
    onSelectFile(selected ? null : file.id);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={
        Platform.OS === "android"
          ? cn(
              "mt-1 min-h-12 justify-center rounded-[20px] px-3 py-2 active:bg-subtle",
              selected && "bg-subtle-strong",
            )
          : selected
            ? "mt-1 min-h-12 justify-center rounded-xl bg-subtle-strong px-3 py-2"
            : "mt-1 min-h-12 justify-center rounded-xl px-3 py-2 active:bg-subtle"
      }
      onPress={handlePress}
    >
      <Text
        className={
          selected
            ? "text-xs font-t3-bold text-foreground"
            : "text-xs font-t3-medium text-foreground-secondary"
        }
        numberOfLines={2}
      >
        {file.path}
      </Text>
      <View className="mt-1 flex-row gap-2">
        <Text className="text-2xs font-t3-bold text-adaptive-emerald-700-300">
          +{formatDiffCount(file.additions)}
        </Text>
        <Text className="text-2xs font-t3-bold text-adaptive-rose-700-300">
          -{formatDiffCount(file.deletions)}
        </Text>
      </View>
    </Pressable>
  );
};

interface ReviewFileNavigatorHandle {
  readonly setVisibleFile: (fileId: string | null) => void;
}

interface ReviewFileNavigatorProps {
  readonly files: ReadonlyArray<ReviewNavigatorFile>;
  readonly sectionId: string | null;
  readonly onSelectFile: (fileId: string | null) => void;
  readonly ref?: Ref<ReviewFileNavigatorHandle>;
}

function ReviewFileNavigator({ files, sectionId, onSelectFile, ref }: ReviewFileNavigatorProps) {
  const [fileSelection, setFileSelection] = useState<{
    readonly sectionId: string | null;
    readonly fileId: string | null;
  }>({ sectionId: null, fileId: null });
  const availableFileIds = files.map((file) => file.id);
  const selectedFileId = resolveSelectedReviewFileId({
    selection: fileSelection,
    sectionId,
    availableFileIds,
  });

  useImperativeHandle(
    ref,
    () => ({
      setVisibleFile: (fileId) => {
        if (fileId !== null && !availableFileIds.includes(fileId)) {
          return;
        }
        setFileSelection((current) => {
          if (current.sectionId === sectionId && current.fileId === fileId) {
            return current;
          }
          return { sectionId, fileId };
        });
      },
    }),
    [availableFileIds, sectionId],
  );

  const handleSelectFile = (fileId: string | null) => {
    setFileSelection({ sectionId, fileId });
    onSelectFile(fileId);
  };

  const renderFile = ({ item }: { readonly item: ReviewNavigatorFile }) => (
    <ReviewFileNavigatorRow
      file={item}
      selected={selectedFileId === item.id}
      onSelectFile={handleSelectFile}
    />
  );

  return (
    <View className="flex-1 ios:bg-sheet android:bg-header">
      <AppBar
        title="Changed files"
        subtitle={`${files.length} ${files.length === 1 ? "file" : "files"}`}
        hideBottomBorder
      />
      <ScreenContent insetHorizontal>
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={files}
          // Rows keep their callback until extraData changes; it reads collapsed files.
          extraData={[selectedFileId, handleSelectFile]}
          keyExtractor={(file) => file.id}
          estimatedItemSize={64}
          recycleItems
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8 }}
          renderItem={renderFile}
        />
      </ScreenContent>
    </View>
  );
}

type ReviewSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

export function ReviewSheet(
  props: ReviewSheetProps & {
    readonly workspaceTabs?: ReactNode;
    readonly workspaceHeader?: ReactNode;
    readonly openedFile?:
      | {
          readonly sectionId: string;
          readonly path?: string;
          readonly scope?: "staged" | "unstaged" | undefined;
        }
      | undefined;
  },
) {
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const insets = useSafeAreaInsets();
  const { themeAppearance: selectedTheme } = useAppearancePreferences();
  const { environmentId, threadId } = props.route.params;
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  const { draftMessage, draftContext } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const safeArea = columnMetrics?.safeArea ?? insets;
  const topContentInset = useContentTopInset();
  const toolbarInset = topContentInset;
  const bottomContentInset =
    Platform.OS === "ios" ? safeArea.bottom + 8 : Math.max(insets.bottom, 18) + 18;

  const memoryKey = workspaceThreadMemoryKey(String(environmentId), String(threadId));
  const [rememberedReview] = useState(() => readThreadReviewSelection(memoryKey));
  const {
    error,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
    isSelectedSectionPending,
    liveGitUnavailableReason,
  } = useReviewSections({
    enabled: isEnvironmentReady,
    environmentId,
    threadId,
    reviewCache,
    selectedSectionId:
      props.openedFile?.sectionId ??
      reviewCache.selectedSectionId ??
      rememberedReview?.sectionId ??
      "git:working-tree",
  });
  useFocusEffect(
    useCallback(() => {
      if (!selectedSection) return;
      rememberThreadReviewSelection(memoryKey, {
        sectionId: selectedSection.id,
        ...(props.openedFile?.path ? { path: props.openedFile.path } : {}),
        ...(props.openedFile?.scope ? { scope: props.openedFile.scope } : {}),
      });
    }, [memoryKey, selectedSection, props.openedFile]),
  );
  useReviewDiffPrewarming({
    threadKey: reviewCache.threadKey,
    sections: reviewSections,
    selectedSectionId: selectedSection?.id ?? null,
  });
  const {
    headerDiffSummary,
    nativeReviewDiffData,
    parsedDiff,
    pendingReviewCommentCount,
    loadVisibleFile,
    isPending: areFilePatchesPending,
  } = useReviewDiffData({
    threadKey: reviewCache.threadKey,
    environmentId,
    cwd: selectedThreadCwd,
    selectedSection: selectedSection?.kind === "working-tree" ? null : selectedSection,
    draftMessage,
    draftContext,
  });
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const nativeReviewDiffViewRef = useRef<NativeReviewDiffViewHandle>(null);
  const showcasedReviewDrawRef = useRef<string | null>(null);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullToRefresh = async () => {
    setIsPullRefreshing(true);
    return await (async () => {
      await refreshSelectedSection();
    })().finally(async () => {
      setIsPullRefreshing(false);
    });
  };
  const isRefreshing = isPullRefreshing || isSelectedSectionPending || areFilePatchesPending;
  // A refresh that starts programmatically adds its height to the native top inset and
  // subtracts it when it ends. If topContentInset changes in between, the inset ends up
  // short and the content sits under the header, so the fallback ScrollView starts over.
  const [fallbackInset, setFallbackInset] = useState(topContentInset);
  const [fallbackScrollViewKey, setFallbackScrollViewKey] = useState(0);
  if (fallbackInset !== topContentInset) {
    setFallbackInset(topContentInset);
    if (isRefreshing) setFallbackScrollViewKey((key) => key + 1);
  }
  const reviewFiles = parsedDiff.kind === "files" ? parsedDiff.files : [];
  const treeFiles =
    parsedDiff.kind === "files"
      ? parsedDiff.files
      : (selectedSection?.files ?? []).map((file) => ({ ...file, changeType: "change" }));
  const fileVisibility = useReviewFileVisibility({
    threadKey: reviewCache.threadKey,
    sectionId: selectedSection?.id ?? null,
    files: reviewFiles,
    cachedExpandedFileIds: selectedSection?.id
      ? reviewCache.expandedFileIdsBySection[selectedSection.id]
      : undefined,
    cachedViewedFileIds: undefined,
  });
  const { collapsedFileIds, toggleExpandedFile } = fileVisibility;
  const displayedDiff = useMemo(
    () =>
      props.openedFile?.path
        ? selectReviewFileDiff(nativeReviewDiffData, props.openedFile.path)
        : nativeReviewDiffData,
    [nativeReviewDiffData, props.openedFile],
  );
  const openedPath = props.openedFile?.path;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the externally requested file into the native diff viewer
  useEffect(() => {
    if (openedPath) loadVisibleFile(openedPath);
  }, [openedPath, loadVisibleFile]);
  const commentSelection = useReviewCommentSelectionController({
    environmentId,
    threadId,
    selectedSection,
    nativeReviewDiffData: displayedDiff,
  });
  const nativeBridge = useNativeReviewDiffBridge({
    threadKey: reviewCache.threadKey,
    sectionId: selectedSection?.id ?? null,
    diff: selectedSection?.diff,
    data: displayedDiff,
    collapsedFileIds,
    viewedFileIds: [],
    selectedRowIds: commentSelection.selectedRowIds,
    canHighlight: props.openedFile !== undefined && parsedDiff.kind === "files",
  });
  const showcaseReviewKey =
    SHOWCASE_ENABLED && parsedDiff.kind === "files" && selectedSection
      ? `${reviewCache.threadKey}:${selectedSection.id}:${nativeBridge.tokensResetKey}:${nativeBridge.themeId}`
      : null;
  const handleNativeDebug = (event: NativeSyntheticEvent<Record<string, unknown>>) => {
    nativeBridge.onDebug(event);
    if (
      showcaseReviewKey === null ||
      showcasedReviewDrawRef.current === showcaseReviewKey ||
      !isNativeReviewDiffDrawEvent(event.nativeEvent)
    ) {
      return;
    }
    showcasedReviewDrawRef.current = showcaseReviewKey;
    reportShowcaseSceneRendered({ scene: "review", themeId: nativeBridge.themeId });
  };

  const reviewFileNavigatorRef = useRef<ReviewFileNavigatorHandle>(null);
  const handleSelectFile = async (fileId: string | null) => {
    loadVisibleFile(fileId, true);
    commentSelection.clearSelection();
    if (fileId !== null && collapsedFileIds.includes(fileId)) toggleExpandedFile(fileId);
    const nativeView = nativeReviewDiffViewRef.current;
    if (nativeView)
      await settlePromise(() =>
        fileId === null ? nativeView.scrollToTop(false) : nativeView.scrollToFile(fileId, false),
      );
  };
  const handleVisibleFileChange = (
    event: NativeSyntheticEvent<{ readonly fileId?: string | null }>,
  ) => {
    loadVisibleFile(event.nativeEvent.fileId ?? null);
  };
  const renderInspector = () => (
    <ReviewFileNavigator
      ref={reviewFileNavigatorRef}
      files={nativeReviewDiffData.files}
      sectionId={selectedSection?.id ?? null}
      onSelectFile={(fileId) => void handleSelectFile(fileId)}
    />
  );

  const openFile = (path: string | undefined, scope?: "staged" | "unstaged") => {
    if (!selectedSection) return;
    navigation.dispatch(
      StackActions.push("ThreadReviewFile", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        reviewSectionId: selectedSection.id,
        ...(path ? { reviewFilePath: path } : {}),
        ...(scope ? { reviewWorkingTreeScope: scope } : {}),
      }),
    );
  };
  const handleNativeToggleFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (fileId) {
        loadVisibleFile(fileId, true);
        toggleExpandedFile(fileId);
      }
    },
    [toggleExpandedFile, loadVisibleFile],
  );

  const parsedDiffNotice =
    parsedDiff.kind === "files" || parsedDiff.kind === "raw" ? parsedDiff.notice : null;
  const hasCachedSelectedDiff = selectedSection?.diff != null;
  const hasAnyCachedDiff = reviewSections.some((section) => section.diff != null);
  const { showConnectionNotice, showSectionToolbar } = resolveReviewAvailability({
    hasEnvironmentPresentation: environment.isReady,
    isEnvironmentConnected: isEnvironmentReady,
    hasCachedSelectedDiff,
    hasAnyCachedDiff,
  });
  const handleRetryEnvironment = () => {
    void retryEnvironment(environmentId);
  };
  const handleReturnToThread = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(threadId) },
    });
  };
  const androidHeaderSubtitle = [
    selectedSection?.title,
    headerDiffSummary.additions,
    headerDiffSummary.deletions,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  const showChangedFilesPane =
    !showConnectionNotice &&
    selectedSection !== null &&
    parsedDiff.kind === "files" &&
    NativeReviewDiffView !== null;

  const listHeader = (() => {
    const children: ReactElement[] = [];

    if (error) {
      children.push(
        <View
          key="review-error"
          className={cn(
            "bg-card px-4 py-3",
            Platform.OS === "android" ? "m-2 rounded-[20px]" : "border-b border-border",
          )}
        >
          <Text className="text-sm font-t3-bold text-foreground">Review unavailable</Text>
          <Text className="text-xs leading-normal text-foreground-muted">{error}</Text>
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
  })();
  const headerSubtitle = [
    headerDiffSummary.additions,
    headerDiffSummary.deletions,
    pendingReviewCommentCount > 0
      ? `${pendingReviewCommentCount} comment${pendingReviewCommentCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const headerTitleText =
    props.openedFile?.path?.split("/").at(-1) ??
    (props.openedFile?.scope === "staged" ? "Staged" : props.openedFile ? "Unstaged" : "Git");

  return (
    <>
      {showChangedFilesPane ? (
        <Inspector
          revealKey={`${environmentId}:${threadId}`}
          content={{ active: "changes", panes: [{ key: "changes", render: renderInspector }] }}
        />
      ) : null}
      {props.workspaceHeader ?? (
        <ReviewHeader
          environmentId={environmentId}
          threadId={threadId}
          title={headerTitleText}
          subtitle={headerSubtitle}
          androidSubtitle={androidHeaderSubtitle}
          selectedThreadCwd={selectedThreadCwd}
          selectedSection={selectedSection}
          onRefresh={handlePullToRefresh}
          onReturnToThread={handleReturnToThread}
        />
      )}

      <ScreenContent>
        <View className="flex-1 bg-sheet android:bg-sheet-solid">
          <View style={{ paddingTop: toolbarInset }}>
            {props.workspaceTabs}
            {showSectionToolbar ? (
              <ReviewComparisonPicker
                sections={reviewSections}
                selected={selectedSection}
                onSelect={(sectionId) => {
                  selectSection(sectionId);
                  if (props.openedFile) navigation.goBack();
                }}
              />
            ) : null}
          </View>
          {liveGitUnavailableReason && !showConnectionNotice ? (
            <Text
              accessibilityRole="alert"
              className="border-b border-warning-border bg-warning px-4 py-3 text-xs leading-normal text-warning-foreground"
            >
              {liveGitUnavailableReason}
            </Text>
          ) : null}
          {showConnectionNotice ? (
            <View className="flex-1" style={{ paddingTop: topContentInset }}>
              <EnvironmentConnectionNotice
                environmentLabel={environment.presentation?.entry.target.label ?? "Environment"}
                connection={
                  environment.presentation?.connection ?? {
                    phase: "available",
                    error: null,
                    traceId: null,
                  }
                }
                resourceName="review"
                onRetry={handleRetryEnvironment}
              />
            </View>
          ) : selectedSection?.kind === "working-tree" && selectedThreadCwd ? (
            <View
              className="flex-1"
              style={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            >
              <WorkingChangesReview
                key={`${environmentId}:${selectedThreadCwd}`}
                environmentId={environmentId}
                threadId={threadId}
                cwd={selectedThreadCwd}
                draftMessage={draftMessage}
                draftContext={draftContext}
                revision={selectedSection?.source?.diffHash}
                onChanged={refreshSelectedSection}
                openedFile={
                  props.openedFile
                    ? {
                        path: props.openedFile.path,
                        scope: props.openedFile.scope === "staged" ? "staged" : "unstaged",
                      }
                    : undefined
                }
                onOpenFile={({ path, scope }) => openFile(path, scope)}
                onOpenScope={(scope) => openFile(undefined, scope)}
              />
            </View>
          ) : !props.openedFile && treeFiles.length > 0 ? (
            <View className="min-h-0 flex-1">
              {listHeader}
              <ReviewFileTree
                files={treeFiles}
                onSelectFile={(path) => openFile(path)}
                onRefresh={() => void handlePullToRefresh()}
                refreshing={isPullRefreshing || isSelectedSectionPending}
              />
            </View>
          ) : props.openedFile &&
            parsedDiff.kind === "files" &&
            displayedDiff.files.length === 0 &&
            !isSelectedSectionPending &&
            !areFilePatchesPending ? (
            <Text className="px-4 py-3 text-xs text-foreground-muted">
              No changes remaining in this file.
            </Text>
          ) : selectedSection && parsedDiff.kind === "files" && NativeReviewDiffView ? (
            <View
              className="flex-1"
              style={{
                backgroundColor: nativeBridge.theme.background,
              }}
            >
              <View
                className="min-w-0 flex-1"
                style={listHeader ? { paddingTop: topContentInset } : undefined}
              >
                {listHeader}
                <View className="min-w-0 flex-1" collapsable={false}>
                  {/* oxlint-disable-next-line react/static-components -- The resolver returns a cached native component with stable identity. */}
                  <NativeReviewDiffView
                    collapsable={false}
                    testID="review-native-diff-view"
                    refreshing={
                      isPullRefreshing || isSelectedSectionPending || areFilePatchesPending
                    }
                    onPullToRefresh={() => void handlePullToRefresh()}
                    style={StyleSheet.absoluteFill}
                    appearanceScheme={selectedTheme}
                    collapsedFileIdsJson={nativeBridge.collapsedFileIdsJson}
                    collapsedCommentIdsJson={nativeBridge.collapsedCommentIdsJson}
                    contentResetKey={`${reviewCache.threadKey}:${selectedSection.id}`}
                    contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
                    contentInsetTop={listHeader ? 0 : topContentInset}
                    contentInsetBottom={bottomContentInset}
                    nativeViewRef={nativeReviewDiffViewRef}
                    rowHeight={nativeReviewDiffStyle.rowHeight}
                    rowsJson={nativeBridge.rowsJson}
                    selectedRowIdsJson={nativeBridge.selectedRowIdsJson}
                    styleJson={nativeBridge.styleJson}
                    themeJson={nativeBridge.themeJson}
                    tokensPatchJson={nativeBridge.tokensPatchJson}
                    tokensResetKey={nativeBridge.tokensResetKey}
                    viewedFileIdsJson={nativeBridge.viewedFileIdsJson}
                    showViewedCheckbox={false}
                    onDebug={handleNativeDebug}
                    onPressLine={commentSelection.onPressLine}
                    enableLineRangeSelection
                    onSelectLineRange={commentSelection.onSelectLineRange}
                    onVisibleFileChange={handleVisibleFileChange}
                    onToggleComment={nativeBridge.onToggleComment}
                    onToggleFile={handleNativeToggleFile}
                  />
                </View>
              </View>
            </View>
          ) : (
            <ScrollView
              key={fallbackScrollViewKey}
              contentContainerStyle={
                Platform.OS === "android" && (parsedDiff.kind === "empty" || !selectedSection)
                  ? { flexGrow: 1, justifyContent: "center" }
                  : undefined
              }
              contentInsetAdjustmentBehavior="never"
              contentInset={{ top: topContentInset, bottom: bottomContentInset }}
              contentOffset={{ x: 0, y: -topContentInset }}
              automaticallyAdjustsScrollIndicatorInsets={false}
              scrollIndicatorInsets={{ top: topContentInset, bottom: bottomContentInset }}
              showsVerticalScrollIndicator={false}
              className="flex-1"
              refreshControl={
                // Fallback and empty states need refresh controls; only Android has an explicit refresh menu.
                <RefreshControl
                  refreshing={isRefreshing}
                  onRefresh={() => void handlePullToRefresh()}
                />
              }
            >
              {listHeader}
              {!selectedSection ? (
                error ? null : (
                  <View
                    className={
                      Platform.OS === "android"
                        ? "items-center px-6 py-5"
                        : "border-b border-border bg-card px-4 py-5"
                    }
                  >
                    <Text className="text-sm font-t3-bold text-foreground">No review diffs</Text>
                    <Text
                      className={cn(
                        "text-xs leading-normal text-foreground-muted",
                        Platform.OS === "android" && "mt-2 text-center",
                      )}
                    >
                      This thread has no ready turn diffs and the worktree diff is empty.
                    </Text>
                  </View>
                )
              ) : selectedSection.isLoading && selectedSection.diff === null ? (
                <View
                  className={cn(
                    "items-center gap-3 px-4 py-6",
                    Platform.OS !== "android" && "border-b border-border bg-card",
                  )}
                >
                  <AppActivityIndicator size="small" />
                  <Text className="text-xs text-foreground-muted">Loading diff…</Text>
                </View>
              ) : parsedDiff.kind === "empty" ? (
                <View
                  className={
                    Platform.OS === "android"
                      ? "items-center px-6 py-5"
                      : "border-b border-border bg-card px-4 py-5"
                  }
                >
                  <Text className="text-sm font-t3-bold text-foreground">No changes</Text>
                  <Text
                    className={cn(
                      "text-xs leading-normal text-foreground-muted",
                      Platform.OS === "android" && "mt-2 text-center",
                    )}
                  >
                    {selectedSection.subtitle ?? "This diff is empty."}
                  </Text>
                </View>
              ) : parsedDiff.kind === "raw" ? (
                <View
                  className={cn(
                    "gap-3 bg-card px-4 py-4",
                    Platform.OS === "android" ? "m-2 rounded-[20px]" : "border-b border-border",
                  )}
                >
                  <Text className="text-xs leading-normal text-foreground-muted">
                    {parsedDiff.reason}
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                    <Text selectable className="font-mono text-xs leading-relaxed text-foreground">
                      {parsedDiff.text}
                    </Text>
                  </ScrollView>
                </View>
              ) : parsedDiff.kind === "files" ? (
                <View
                  className={cn(
                    "gap-3 bg-card px-4 py-4",
                    Platform.OS === "android" ? "m-2 rounded-[20px]" : "border-b border-border",
                  )}
                >
                  <Text className="text-xs leading-normal text-foreground-muted">
                    Native diff view unavailable. Showing the raw patch.
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                    <Text selectable className="font-mono text-xs leading-relaxed text-foreground">
                      {selectedSection?.diff ?? ""}
                    </Text>
                  </ScrollView>
                </View>
              ) : null}
            </ScrollView>
          )}
          <ReviewSelectionActionBar
            bottomInset={insets.bottom}
            title={commentSelection.selectionAction?.title ?? null}
            onOpenComment={commentSelection.selectionAction?.onOpenComment ?? null}
            onClear={commentSelection.clearSelection}
          />
        </View>
      </ScreenContent>
    </>
  );
}
