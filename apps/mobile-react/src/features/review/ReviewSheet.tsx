import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../native/StackHeader";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { SymbolView } from "expo-symbols";
import {
  memo,
  type Ref,
  type ReactElement,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  type NativeSyntheticEvent,
  StyleSheet,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { useEnvironmentQuery } from "../../state/query";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { ThreadGitMenu } from "../threads/ThreadGitControls";
import { useReviewCacheForThread } from "./reviewState";
import {
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
import { resolveSelectedReviewFileId } from "./reviewPaneSelection";
import { buildReviewSectionMenu } from "./review-section-menu";

const REVIEW_HEADER_SPACING = 0;

const ReviewNotice = memo(function ReviewNotice(props: { readonly notice: string }) {
  return (
    <View className="border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40">
      <Text className="text-xs font-t3-bold uppercase text-amber-700 dark:text-amber-300">
        Partial diff
      </Text>
      <Text className="text-xs leading-normal text-amber-800 dark:text-amber-200">
        {props.notice}
      </Text>
    </View>
  );
});

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
        tintColor="#ffffff"
        type="monochrome"
      />
      <Text className="text-base font-t3-bold text-white">{props.title}</Text>
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
          className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-blue-600 px-5"
          onPress={props.onOpenComment}
        >
          {content}
        </Pressable>
      ) : (
        <View className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-blue-600 px-5">
          {content}
        </View>
      )}

      <Pressable
        className="h-12 w-12 items-center justify-center rounded-full bg-blue-600"
        onPress={props.onClear}
      >
        <SymbolView name="xmark" size={16} tintColor="#ffffff" type="monochrome" />
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

const ReviewFileNavigatorRow = memo(function ReviewFileNavigatorRow(props: {
  readonly file: ReviewNavigatorFile;
  readonly selected: boolean;
  readonly onSelectFile: (fileId: string | null) => void;
}) {
  const { file, selected, onSelectFile } = props;
  // Tapping the selected file again returns to the all-files diff.
  const handlePress = useCallback(() => {
    onSelectFile(selected ? null : file.id);
  }, [file.id, onSelectFile, selected]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={
        selected
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
        <Text className="text-2xs font-t3-bold text-emerald-600">+{file.additions}</Text>
        <Text className="text-2xs font-t3-bold text-rose-600">-{file.deletions}</Text>
      </View>
    </Pressable>
  );
});

interface ReviewFileNavigatorHandle {
  readonly setVisibleFile: (fileId: string | null) => void;
}

interface ReviewFileNavigatorProps {
  readonly files: ReadonlyArray<ReviewNavigatorFile>;
  readonly headerInset: number;
  readonly sectionId: string | null;
  readonly onSelectFile: (fileId: string | null) => void;
  readonly ref?: Ref<ReviewFileNavigatorHandle>;
}

function ReviewFileNavigator({
  files,
  headerInset,
  sectionId,
  onSelectFile,
  ref,
}: ReviewFileNavigatorProps) {
  const insets = useSafeAreaInsets();
  const sheetColor = String(useThemeColor("--color-sheet"));
  const foregroundColor = String(useThemeColor("--color-foreground"));
  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
  const [fileSelection, setFileSelection] = useState<{
    readonly sectionId: string | null;
    readonly fileId: string | null;
  }>({ sectionId: null, fileId: null });
  const availableFileIds = useMemo(() => files.map((file) => file.id), [files]);
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

  const handleSelectFile = useCallback(
    (fileId: string | null) => {
      setFileSelection({ sectionId, fileId });
      onSelectFile(fileId);
    },
    [onSelectFile, sectionId],
  );

  const renderFile = useCallback(
    ({ item }: { readonly item: ReviewNavigatorFile }) => (
      <ReviewFileNavigatorRow
        file={item}
        selected={selectedFileId === item.id}
        onSelectFile={handleSelectFile}
      />
    ),
    [handleSelectFile, selectedFileId],
  );

  const fileList = (
    <FlatList
      data={files}
      extraData={selectedFileId}
      keyExtractor={(file) => file.id}
      contentContainerStyle={{
        paddingHorizontal: 8,
        paddingBottom: 8,
        // The nested native header is translucent; start the list below it so
        // the scroll-edge effect can sample the content (same treatment as
        // FileTreeBrowser in the Files pane).
        paddingTop: Platform.OS === "ios" ? insets.top + 44 + 8 : 8,
      }}
      scrollIndicatorInsets={Platform.OS === "ios" ? { top: insets.top + 44 } : undefined}
      renderItem={renderFile}
    />
  );

  if (Platform.OS === "ios") {
    return (
      <View className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="review-file-navigator-native"
            scrollEdgeEffects={headerScrollEdgeEffects}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {fileList}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              subtitle={`${files.length} ${files.length === 1 ? "file" : "files"}`}
              title="Changed files"
              titleColor={foregroundColor}
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View className="flex-1 border-l border-border bg-sheet">
      <View className="border-b border-border" style={{ paddingTop: headerInset }}>
        <View className="px-4 py-3">
          <Text className="text-sm font-t3-bold text-foreground">Changed files</Text>
          <Text className="text-xs text-foreground-muted">
            {files.length} {files.length === 1 ? "file" : "files"}
          </Text>
        </View>
      </View>
      {fileList}
    </View>
  );
}

type ReviewSheetProps = StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>;

export function ReviewSheet(props: ReviewSheetProps) {
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  useAdaptiveWorkspacePaneRole("inspector");
  const { panes, showAuxiliaryPane, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const headerIcon = String(useThemeColor("--color-icon"));
  const { environmentId, threadId } = props.route.params;
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  const { draftMessage } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  /* ─── Git actions for the toolbar menu (commit/push without leaving review) ── */
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const gitStatusQuery = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  // The selection-based git hooks only apply when this review belongs to the
  // selected thread (it always does when reached from the thread's toolbar).
  const gitMenuAvailable =
    selectedThread !== null && String(selectedThread.id) === String(threadId);
  const selectedTheme = colorScheme === "dark" ? "dark" : "light";
  // With a solid (non-overlay) header the content lays out below the header
  // natively, so no manual top inset is needed.
  const topContentInset = 0;

  useEffect(() => {
    showAuxiliaryPane("inspector");
  }, [environmentId, showAuxiliaryPane, threadId]);
  const { error, reviewSections, selectedSection, refreshSelectedSection, selectSection } =
    useReviewSections({
      enabled: isEnvironmentReady,
      environmentId,
      threadId,
      reviewCache,
    });
  useReviewDiffPrewarming({
    threadKey: reviewCache.threadKey,
    sections: reviewSections,
    selectedSectionId: selectedSection?.id ?? null,
  });
  const { headerDiffSummary, nativeReviewDiffData, parsedDiff, pendingReviewCommentCount } =
    useReviewDiffData({
      threadKey: reviewCache.threadKey,
      selectedSection,
      draftMessage,
    });
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const nativeReviewDiffViewRef = useRef<NativeReviewDiffViewHandle>(null);
  // Native pull-to-refresh on the diff surface (replaces the old Refresh menu item).
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullToRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await refreshSelectedSection();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [refreshSelectedSection]);
  const reviewFileNavigatorRef = useRef<ReviewFileNavigatorHandle>(null);
  const reviewFiles = parsedDiff.kind === "files" ? parsedDiff.files : [];
  const fileVisibility = useReviewFileVisibility({
    threadKey: reviewCache.threadKey,
    sectionId: selectedSection?.id ?? null,
    files: reviewFiles,
    cachedExpandedFileIds: selectedSection?.id
      ? reviewCache.expandedFileIdsBySection[selectedSection.id]
      : undefined,
    cachedViewedFileIds: selectedSection?.id
      ? reviewCache.viewedFileIdsBySection[selectedSection.id]
      : undefined,
  });
  const { collapsedFileIds, toggleExpandedFile, toggleViewedFile, viewedFileIds } = fileVisibility;
  const commentSelection = useReviewCommentSelectionController({
    environmentId,
    threadId,
    selectedSection,
    nativeReviewDiffData,
  });
  const nativeBridge = useNativeReviewDiffBridge({
    threadKey: reviewCache.threadKey,
    sectionId: selectedSection?.id ?? null,
    diff: selectedSection?.diff,
    data: nativeReviewDiffData,
    scheme: selectedTheme,
    collapsedFileIds,
    viewedFileIds,
    selectedRowIds: commentSelection.selectedRowIds,
    canHighlight: parsedDiff.kind === "files",
  });

  const handleSelectFile = useCallback(
    (fileId: string | null) => {
      commentSelection.clearSelection();
      if (fileId !== null && collapsedFileIds.includes(fileId)) {
        toggleExpandedFile(fileId);
      }
      const navigation =
        fileId === null
          ? nativeReviewDiffViewRef.current?.scrollToTop(true)
          : nativeReviewDiffViewRef.current?.scrollToFile(fileId, true);
      void navigation?.catch((error: unknown) => {
        console.error("[review] Failed to navigate to diff file", error);
      });
    },
    [collapsedFileIds, commentSelection, toggleExpandedFile],
  );
  const handleVisibleFileChange = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string | null }>) => {
      reviewFileNavigatorRef.current?.setVisibleFile(event.nativeEvent.fileId ?? null);
    },
    [],
  );
  const renderInspector = useCallback(
    () => (
      <ReviewFileNavigator
        ref={reviewFileNavigatorRef}
        files={nativeReviewDiffData.files}
        // The workspace inspector column spans the full window height, so the
        // pane clears the status bar itself.
        headerInset={insets.top}
        sectionId={selectedSection?.id ?? null}
        onSelectFile={handleSelectFile}
      />
    ),
    [handleSelectFile, insets.top, nativeReviewDiffData.files, selectedSection?.id],
  );

  const handleNativeToggleFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (fileId) {
        toggleExpandedFile(fileId);
      }
    },
    [toggleExpandedFile],
  );

  const handleNativeToggleViewedFile = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string }>) => {
      const { fileId } = event.nativeEvent;
      if (fileId) {
        toggleViewedFile(fileId);
      }
    },
    [toggleViewedFile],
  );

  const parsedDiffNotice =
    parsedDiff.kind === "files" || parsedDiff.kind === "raw" ? parsedDiff.notice : null;
  const hasCachedSelectedDiff = selectedSection?.diff != null;
  const hasAnyCachedDiff = reviewSections.some((section) => section.diff != null);
  const sectionMenu = useMemo(() => buildReviewSectionMenu(reviewSections), [reviewSections]);
  const { showConnectionNotice, showSectionToolbar } = resolveReviewAvailability({
    hasEnvironmentPresentation: environment.isReady,
    isEnvironmentConnected: isEnvironmentReady,
    hasCachedSelectedDiff,
    hasAnyCachedDiff,
  });
  const handleRetryEnvironment = useCallback(() => {
    void retryEnvironment(environmentId);
  }, [environmentId, retryEnvironment]);
  const handleReturnToThread = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.navigate("Thread", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  }, [environmentId, navigation, threadId]);

  // The changed-files navigator lives in the workspace inspector column —
  // the single right-hand pane per route — instead of an in-screen panel.
  const showChangedFilesPane =
    !showConnectionNotice && selectedSection !== null && parsedDiff.kind === "files";
  useRegisterWorkspaceInspector(showChangedFilesPane ? renderInspector : undefined);

  const listHeader = useMemo(() => {
    const children: ReactElement[] = [];

    if (error) {
      children.push(
        <View key="review-error" className="border-b border-border bg-card px-4 py-3">
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
  }, [error, parsedDiffNotice]);
  const headerSubtitle = [
    headerDiffSummary.additions,
    headerDiffSummary.deletions,
    pendingReviewCommentCount > 0
      ? `${pendingReviewCommentCount} comment${pendingReviewCommentCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const headerTitleText = selectedSection?.title ?? "Review changes";

  return (
    <>
      <NativeStackScreenOptions
        options={{
          // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS — the native
          // diff scrolls internally, nothing for glass to sample). Only dynamic values
          // here.
          headerTintColor: headerIcon,
          headerTitle: headerTitleText,
          title: headerTitleText,
          unstable_headerSubtitle:
            Platform.OS === "ios" && headerSubtitle.length > 0 ? headerSubtitle : undefined,
        }}
      />

      <WorkspaceSidebarToolbar>
        <NativeHeaderToolbar.Button
          accessibilityLabel="Back to chat"
          icon="chevron.left"
          onPress={handleReturnToThread}
        />
      </WorkspaceSidebarToolbar>

      {showSectionToolbar || panes.supportsAuxiliaryPane || gitMenuAvailable ? (
        <NativeHeaderToolbar placement="right">
          {panes.supportsAuxiliaryPane ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel={
                panes.auxiliaryPaneVisible ? "Hide changed files" : "Show changed files"
              }
              icon="sidebar.right"
              onPress={toggleAuxiliaryPane}
              separateBackground
            />
          ) : null}
          {gitMenuAvailable && selectedThread !== null ? (
            <ThreadGitMenu
              environmentId={environmentId}
              threadId={threadId}
              currentBranch={selectedThread.branch ?? null}
              gitStatus={gitStatusQuery.data}
              gitOperationLabel={gitState.gitOperationLabel}
              onPull={gitActions.onPullSelectedThreadBranch}
              onRunAction={gitActions.onRunSelectedThreadGitAction}
            />
          ) : null}
          {showSectionToolbar ? (
            <NativeHeaderToolbar.Menu icon="ellipsis" title="Select diff" separateBackground>
              <NativeHeaderToolbar.Menu inline>
                <NativeHeaderToolbar.MenuAction
                  disabled={sectionMenu.workingTree === null}
                  isOn={selectedSection?.id === sectionMenu.workingTree?.id}
                  onPress={() => {
                    if (sectionMenu.workingTree) {
                      selectSection(sectionMenu.workingTree.id);
                    }
                  }}
                >
                  <NativeHeaderToolbar.Label>Working tree</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                <NativeHeaderToolbar.MenuAction
                  disabled={sectionMenu.branchChanges === null}
                  isOn={selectedSection?.id === sectionMenu.branchChanges?.id}
                  onPress={() => {
                    if (sectionMenu.branchChanges) {
                      selectSection(sectionMenu.branchChanges.id);
                    }
                  }}
                >
                  <NativeHeaderToolbar.Label>Branch changes</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                <NativeHeaderToolbar.MenuAction
                  disabled={sectionMenu.latestTurn === null}
                  isOn={selectedSection?.id === sectionMenu.latestTurn?.id}
                  onPress={() => {
                    if (sectionMenu.latestTurn) {
                      selectSection(sectionMenu.latestTurn.id);
                    }
                  }}
                >
                  <NativeHeaderToolbar.Label>Latest turn</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                {sectionMenu.turns.length > 0 ? (
                  <NativeHeaderToolbar.Menu title="Turn">
                    {sectionMenu.turns.map((section) => (
                      <NativeHeaderToolbar.MenuAction
                        key={section.id}
                        isOn={section.id === selectedSection?.id}
                        onPress={() => selectSection(section.id)}
                        subtitle={section.subtitle ?? undefined}
                      >
                        <NativeHeaderToolbar.Label>{section.title}</NativeHeaderToolbar.Label>
                      </NativeHeaderToolbar.MenuAction>
                    ))}
                  </NativeHeaderToolbar.Menu>
                ) : null}
              </NativeHeaderToolbar.Menu>
            </NativeHeaderToolbar.Menu>
          ) : null}
        </NativeHeaderToolbar>
      ) : null}

      <View className="flex-1 bg-sheet">
        {showConnectionNotice ? (
          <View style={{ flex: 1, paddingTop: topContentInset }}>
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
        ) : selectedSection && parsedDiff.kind === "files" && NativeReviewDiffView != null ? (
          <View
            className="flex-1"
            style={{
              backgroundColor: nativeBridge.theme.background,
            }}
          >
            <View
              className="min-w-0 flex-1"
              style={{ paddingTop: topContentInset + REVIEW_HEADER_SPACING }}
            >
              {listHeader}
              <View className="min-w-0 flex-1" collapsable={false}>
                <NativeReviewDiffView
                  collapsable={false}
                  testID="review-native-diff-view"
                  refreshing={isPullRefreshing}
                  onPullToRefresh={() => void handlePullToRefresh()}
                  style={StyleSheet.absoluteFill}
                  appearanceScheme={selectedTheme}
                  collapsedFileIdsJson={nativeBridge.collapsedFileIdsJson}
                  collapsedCommentIdsJson={nativeBridge.collapsedCommentIdsJson}
                  contentResetKey={`${reviewCache.threadKey}:${selectedSection.id}`}
                  contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
                  nativeViewRef={nativeReviewDiffViewRef}
                  rowHeight={nativeReviewDiffStyle.rowHeight}
                  rowsJson={nativeBridge.rowsJson}
                  selectedRowIdsJson={nativeBridge.selectedRowIdsJson}
                  styleJson={nativeBridge.styleJson}
                  themeJson={nativeBridge.themeJson}
                  tokensPatchJson={nativeBridge.tokensPatchJson}
                  tokensResetKey={nativeBridge.tokensResetKey}
                  viewedFileIdsJson={nativeBridge.viewedFileIdsJson}
                  onDebug={nativeBridge.onDebug}
                  onPressLine={commentSelection.onPressLine}
                  onVisibleFileChange={handleVisibleFileChange}
                  onToggleComment={nativeBridge.onToggleComment}
                  onToggleFile={handleNativeToggleFile}
                  onToggleViewedFile={handleNativeToggleViewedFile}
                />
              </View>
            </View>
          </View>
        ) : (
          <ScrollView
            contentInsetAdjustmentBehavior="never"
            contentInset={{ top: topContentInset, bottom: Math.max(insets.bottom, 18) + 18 }}
            contentOffset={{ x: 0, y: -topContentInset }}
            scrollIndicatorInsets={{
              top: topContentInset,
              bottom: Math.max(insets.bottom, 18) + 18,
            }}
            showsVerticalScrollIndicator={false}
            style={{ flex: 1 }}
          >
            {listHeader}
            {!selectedSection ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-sm font-t3-bold text-foreground">No review diffs</Text>
                <Text className="text-xs leading-normal text-foreground-muted">
                  This thread has no ready turn diffs and the worktree diff is empty.
                </Text>
              </View>
            ) : selectedSection.isLoading && selectedSection.diff === null ? (
              <View className="items-center gap-3 border-b border-border bg-card px-4 py-6">
                <ActivityIndicator size="small" />
                <Text className="text-xs text-foreground-muted">Loading diff…</Text>
              </View>
            ) : parsedDiff.kind === "empty" ? (
              <View className="border-b border-border bg-card px-4 py-5">
                <Text className="text-sm font-t3-bold text-foreground">No changes</Text>
                <Text className="text-xs leading-normal text-foreground-muted">
                  {selectedSection.subtitle ?? "This diff is empty."}
                </Text>
              </View>
            ) : parsedDiff.kind === "raw" ? (
              <View className="gap-3 border-b border-border bg-card px-4 py-4">
                <Text className="text-xs leading-normal text-foreground-muted">
                  {parsedDiff.reason}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                  <Text selectable className="font-mono text-xs leading-relaxed text-foreground">
                    {parsedDiff.text}
                  </Text>
                </ScrollView>
              </View>
            ) : parsedDiff.kind === "files" && selectedSection.diff ? (
              <View className="gap-3 border-b border-border bg-card px-4 py-4">
                <Text className="text-xs leading-normal text-foreground-muted">
                  The native diff view is unavailable. Showing the raw diff instead.
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                  <Text selectable className="font-mono text-xs leading-relaxed text-foreground">
                    {selectedSection.diff}
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
    </>
  );
}
