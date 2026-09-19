import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";
import type { ReviewSectionItem } from "./reviewModel";
import { useReviewHeaderPresentation } from "./useReviewHeaderPresentation";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
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
  RefreshControl,
  ScrollView,
  type NativeSyntheticEvent,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { cn } from "../../lib/cn";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
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
import { resolveSelectedReviewFileId } from "./reviewPaneSelection";
import { buildReviewSectionMenu } from "./review-section-menu";
import { reportShowcaseSceneRendered } from "../showcase/showcaseRenderSignal";

function ReviewHeader(
  props: Parameters<typeof useReviewHeaderPresentation>[0] & {
    readonly iconColor: string;
    readonly sectionMenu: ReturnType<typeof buildReviewSectionMenu>;
    readonly showSectionToolbar: boolean;
    readonly showChangedFilesToggle: boolean;
    readonly onSelectSection: (sectionId: string) => void;
    readonly onReturnToThread: () => void;
  },
) {
  const { panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const presentation = useReviewHeaderPresentation(props);
  const sectionAction = (
    section: ReviewSectionItem | null,
    title: string,
  ): ScreenHeaderMenuItem => ({
    id: section ? `section:${section.id}` : `unavailable:${title}`,
    title,
    disabled: section === null,
    selected: section !== null && section.id === props.selectedSection?.id,
    onPress: () => {
      if (section) props.onSelectSection(section.id);
    },
  });
  return (
    <ScreenHeader
      title={presentation.title}
      subtitle={presentation.subtitle}
      onBack={props.onReturnToThread}
      hideBottomBorder
      options={{ headerTintColor: props.iconColor, headerTitle: props.title }}
      backInSplitView={{ accessibilityLabel: "Back to chat", icon: "chevron.left" }}
      actions={
        props.showChangedFilesToggle
          ? [
              {
                accessibilityLabel: panes.auxiliaryPaneVisible
                  ? "Hide changed files"
                  : "Show changed files",
                icon: "sidebar.right",
                selected: panes.auxiliaryPaneVisible,
                onPress: toggleAuxiliaryPane,
              },
            ]
          : undefined
      }
      menus={[
        ...(presentation.gitMenu ? [presentation.gitMenu] : []),
        ...(props.showSectionToolbar
          ? [
              {
                title: "Select diff",
                icon: presentation.menuIcon,
                items: [
                  {
                    id: "sections",
                    inline: true,
                    items: [
                      sectionAction(props.sectionMenu.workingTree, "Working tree"),
                      sectionAction(props.sectionMenu.branchChanges, "Branch changes"),
                      sectionAction(props.sectionMenu.latestTurn, "Latest turn"),
                    ],
                  },
                  ...(props.sectionMenu.turns.length > 0
                    ? [
                        {
                          id: "turns",
                          title: "Turn",
                          items: props.sectionMenu.turns.map((section) => ({
                            id: `section:${section.id}`,
                            title: section.title,
                            subtitle: section.subtitle ?? undefined,
                            selected: section.id === props.selectedSection?.id,
                            onPress: () => props.onSelectSection(section.id),
                          })),
                        },
                      ]
                    : []),
                  ...(presentation.refreshAction ? [presentation.refreshAction] : []),
                ],
              },
            ]
          : []),
      ]}
    />
  );
}

const REVIEW_HEADER_SPACING = 0;
const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

const ReviewNotice = memo(function ReviewNotice(props: { readonly notice: string }) {
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
          +{file.additions}
        </Text>
        <Text className="text-2xs font-t3-bold text-adaptive-rose-700-300">-{file.deletions}</Text>
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
  const theme = useUniwindTheme();
  const sheetColor = theme["--color-sheet"];
  const foregroundColor = theme["--color-foreground"];
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
        paddingTop: Platform.OS === "ios" ? insets.top + IOS_NAV_BAR_HEIGHT + 8 : 8,
      }}
      scrollIndicatorInsets={
        Platform.OS === "ios" ? { top: insets.top + IOS_NAV_BAR_HEIGHT } : undefined
      }
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
    <View
      className={
        Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 border-l border-border bg-sheet"
      }
    >
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Changed files"
          subtitle={`${files.length} ${files.length === 1 ? "file" : "files"}`}
          hideBottomBorder
        />
      ) : (
        <View className="border-b border-border" style={{ paddingTop: headerInset }}>
          <View className="px-4 py-3">
            <Text className="text-sm font-t3-bold text-foreground">Changed files</Text>
            <Text className="text-xs text-foreground-muted">
              {files.length} {files.length === 1 ? "file" : "files"}
            </Text>
          </View>
        </View>
      )}
      <MaterialScreenContent insetHorizontal>{fileList}</MaterialScreenContent>
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
  const { panes, showAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { themeAppearance: selectedTheme } = useAppearancePreferences();
  const headerIcon = String(useUniwindTheme()["--color-icon"]);
  const { environmentId, threadId } = props.route.params;
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  const { draftMessage } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  // With a solid (non-overlay) header the content lays out below the header
  // natively, so no manual top inset is needed. (Android renders its own
  // in-flow AndroidScreenHeader, so it needs no inset either.)
  const topContentInset = 0;

  useEffect(() => {
    showAuxiliaryPane("inspector");
  }, [environmentId, showAuxiliaryPane, threadId]);
  const {
    error,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
    isSelectedSectionPending,
    diffPreviewRevision,
  } = useReviewSections({
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
    selectedSection,
    revision: diffPreviewRevision,
    draftMessage,
  });
  // Resolution returns null while Expo registers the native view (or forever
  // when the binary lacks it). Rendering a null component type crashes the
  // app, so callers must fall back — ThreadFeed's ReviewCommentCard does the
  // same check.
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const nativeReviewDiffViewRef = useRef<NativeReviewDiffViewHandle>(null);
  const showcasedReviewDrawRef = useRef<string | null>(null);
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
    collapsedFileIds,
    viewedFileIds,
    selectedRowIds: commentSelection.selectedRowIds,
    canHighlight: parsedDiff.kind === "files",
  });
  const showcaseReviewKey =
    SHOWCASE_ENABLED && parsedDiff.kind === "files" && selectedSection
      ? `${reviewCache.threadKey}:${selectedSection.id}:${nativeBridge.tokensResetKey}:${nativeBridge.themeId}`
      : null;
  const handleNativeDebug = useCallback(
    (event: NativeSyntheticEvent<Record<string, unknown>>) => {
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
    },
    [nativeBridge.onDebug, nativeBridge.themeId, showcaseReviewKey],
  );

  const handleSelectFile = useCallback(
    (fileId: string | null) => {
      loadVisibleFile(fileId, true);
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
    [collapsedFileIds, commentSelection, toggleExpandedFile, loadVisibleFile],
  );
  const handleVisibleFileChange = useCallback(
    (event: NativeSyntheticEvent<{ readonly fileId?: string | null }>) => {
      loadVisibleFile(event.nativeEvent.fileId ?? null);
      reviewFileNavigatorRef.current?.setVisibleFile(event.nativeEvent.fileId ?? null);
    },
    [loadVisibleFile],
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
        loadVisibleFile(fileId, true);
        toggleExpandedFile(fileId);
      }
    },
    [toggleExpandedFile, loadVisibleFile],
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
  const androidHeaderSubtitle = [
    selectedSection?.title,
    headerDiffSummary.additions,
    headerDiffSummary.deletions,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  // The changed-files navigator drives the native diff surface via
  // scrollToFile, so it is only useful when that surface resolved. In raw
  // fallback mode the ref is necessarily null and the raw patch neither
  // scrolls nor filters — registering the navigator would present working
  // controls that cannot navigate.
  const showChangedFilesPane =
    !showConnectionNotice &&
    selectedSection !== null &&
    parsedDiff.kind === "files" &&
    NativeReviewDiffView !== null;
  useRegisterWorkspaceInspector(showChangedFilesPane ? renderInspector : undefined);
  // A toggle needs registered content; loading, errors and raw patches have no navigator pane.
  const showChangedFilesToggle = panes.supportsAuxiliaryPane && showChangedFilesPane;

  const listHeader = useMemo(() => {
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
      <ReviewHeader
        environmentId={environmentId}
        threadId={threadId}
        title={headerTitleText}
        subtitle={headerSubtitle}
        androidSubtitle={androidHeaderSubtitle}
        iconColor={headerIcon}
        selectedThreadCwd={selectedThreadCwd}
        sectionMenu={sectionMenu}
        selectedSection={selectedSection}
        showSectionToolbar={showSectionToolbar}
        showChangedFilesToggle={showChangedFilesToggle}
        onRefresh={handlePullToRefresh}
        onSelectSection={selectSection}
        onReturnToThread={handleReturnToThread}
      />

      <MaterialScreenContent>
        <View className={Platform.OS === "android" ? "flex-1 bg-sheet-solid" : "flex-1 bg-sheet"}>
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
          ) : selectedSection && parsedDiff.kind === "files" && NativeReviewDiffView ? (
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
                    nativeViewRef={nativeReviewDiffViewRef}
                    rowHeight={nativeReviewDiffStyle.rowHeight}
                    rowsJson={nativeBridge.rowsJson}
                    selectedRowIdsJson={nativeBridge.selectedRowIdsJson}
                    styleJson={nativeBridge.styleJson}
                    themeJson={nativeBridge.themeJson}
                    tokensPatchJson={nativeBridge.tokensPatchJson}
                    tokensResetKey={nativeBridge.tokensResetKey}
                    viewedFileIdsJson={nativeBridge.viewedFileIdsJson}
                    onDebug={handleNativeDebug}
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
              contentContainerStyle={
                Platform.OS === "android" && (parsedDiff.kind === "empty" || !selectedSection)
                  ? { flexGrow: 1, justifyContent: "center" }
                  : undefined
              }
              contentInsetAdjustmentBehavior="never"
              contentInset={{ top: topContentInset, bottom: Math.max(insets.bottom, 18) + 18 }}
              contentOffset={{ x: 0, y: -topContentInset }}
              scrollIndicatorInsets={{
                top: topContentInset,
                bottom: Math.max(insets.bottom, 18) + 18,
              }}
              showsVerticalScrollIndicator={false}
              className="flex-1"
              refreshControl={
                // The native diff surface owns pull-to-refresh via onPullToRefresh;
                // the raw fallback (and empty states) need an explicit control —
                // iOS has no other refresh affordance here (the explicit
                // "Refresh current diff" menu is Android-only).
                <RefreshControl
                  refreshing={isPullRefreshing || isSelectedSectionPending || areFilePatchesPending}
                  onRefresh={() => void handlePullToRefresh()}
                />
              }
            >
              {listHeader}
              {!selectedSection ? (
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
              ) : selectedSection.isLoading && selectedSection.diff === null ? (
                <View
                  className={cn(
                    "items-center gap-3 px-4 py-6",
                    Platform.OS !== "android" && "border-b border-border bg-card",
                  )}
                >
                  <ActivityIndicator size="small" />
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
                // The native diff surface could not be resolved on this binary;
                // degrade to the raw patch instead of crashing the app.
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
      </MaterialScreenContent>
    </>
  );
}
