import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/build/react-navigation/elements";
import Stack from "expo-router/stack";
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
  Pressable,
  ScrollView,
  type NativeSyntheticEvent,
  Text as NativeText,
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
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { AdaptiveInspectorLayout } from "../layout/adaptive-inspector-layout";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
} from "../layout/AdaptiveWorkspaceLayout";
import { useReviewCacheForThread } from "./reviewState";
import {
  type NativeReviewDiffViewHandle,
  resolveNativeReviewDiffView,
} from "../diffs/nativeReviewDiffSurface";
import {
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
  NATIVE_REVIEW_DIFF_ROW_HEIGHT,
} from "./nativeReviewDiffAdapter";
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
      <Text className="text-xs leading-[18px] text-amber-800 dark:text-amber-200">
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
  const handlePress = useCallback(() => {
    onSelectFile(file.id);
  }, [file.id, onSelectFile]);

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
      <FlatList
        data={files}
        extraData={selectedFileId}
        keyExtractor={(file) => file.id}
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 8 }}
        ListHeaderComponent={
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: selectedFileId === null }}
            className={
              selectedFileId === null
                ? "min-h-11 justify-center rounded-xl bg-subtle-strong px-3"
                : "min-h-11 justify-center rounded-xl px-3 active:bg-subtle"
            }
            onPress={() => handleSelectFile(null)}
          >
            <Text className="text-sm font-t3-bold text-foreground">All files</Text>
            <Text className="text-xs text-foreground-muted">
              {files.length} changed {files.length === 1 ? "file" : "files"}
            </Text>
          </Pressable>
        }
        renderItem={renderFile}
      />
    </View>
  );
}

function ReviewHeaderTitle(props: {
  readonly additions: string | null;
  readonly deletions: string | null;
  readonly foregroundColor: string;
  readonly mutedColor: string;
  readonly pendingCommentCount: number;
  readonly sectionTitle: string;
}) {
  return (
    <View style={{ alignItems: "center" }}>
      <NativeText
        numberOfLines={1}
        style={{
          fontFamily: "DMSans_700Bold",
          fontSize: MOBILE_TYPOGRAPHY.headline.fontSize,
          fontWeight: "900",
          color: props.foregroundColor,
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
        {props.additions && props.deletions ? (
          <>
            <NativeText
              style={{
                fontFamily: "DMSans_700Bold",
                fontSize: MOBILE_TYPOGRAPHY.label.fontSize,
                fontWeight: "700",
                color: "#16a34a",
              }}
            >
              {props.additions}
            </NativeText>
            <NativeText
              style={{
                fontFamily: "DMSans_700Bold",
                fontSize: MOBILE_TYPOGRAPHY.label.fontSize,
                fontWeight: "700",
                color: "#e11d48",
              }}
            >
              {props.deletions}
            </NativeText>
            {props.pendingCommentCount > 0 ? (
              <NativeText
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: MOBILE_TYPOGRAPHY.label.fontSize,
                  fontWeight: "700",
                  color: "#b45309",
                }}
              >
                {props.pendingCommentCount} pending
              </NativeText>
            ) : null}
          </>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <NativeText
              numberOfLines={1}
              style={{
                fontFamily: "DMSans_700Bold",
                fontSize: MOBILE_TYPOGRAPHY.label.fontSize,
                fontWeight: "700",
                color: props.mutedColor,
              }}
            >
              {props.sectionTitle}
            </NativeText>
            {props.pendingCommentCount > 0 ? (
              <NativeText
                style={{
                  fontFamily: "DMSans_700Bold",
                  fontSize: MOBILE_TYPOGRAPHY.label.fontSize,
                  fontWeight: "700",
                  color: "#b45309",
                }}
              >
                {props.pendingCommentCount} pending
              </NativeText>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

export function ReviewSheet() {
  useAdaptiveWorkspacePaneRole("inspector");
  const { layout, panes, showAuxiliaryPane, toggleAuxiliaryPane, togglePrimarySidebar } =
    useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const colorScheme = useColorScheme();
  const headerForeground = String(useThemeColor("--color-foreground"));
  const headerMuted = String(useThemeColor("--color-foreground-muted"));
  const headerIcon = String(useThemeColor("--color-icon"));
  const { environmentId, threadId } = useLocalSearchParams<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
  }>();
  const environment = useEnvironmentPresentation(environmentId);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  const { draftMessage } = useThreadDraftForThread({ environmentId, threadId });
  const reviewCache = useReviewCacheForThread({ environmentId, threadId });
  const selectedTheme = colorScheme === "dark" ? "dark" : "light";
  const topContentInset = headerHeight;

  useEffect(() => {
    showAuxiliaryPane("inspector");
  }, [environmentId, showAuxiliaryPane, threadId]);
  const {
    error,
    loadingGitDiffs,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
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
  const { headerDiffSummary, nativeReviewDiffData, parsedDiff, pendingReviewCommentCount } =
    useReviewDiffData({
      threadKey: reviewCache.threadKey,
      selectedSection,
      draftMessage,
    });
  const NativeReviewDiffView = resolveNativeReviewDiffView()!;
  const nativeReviewDiffViewRef = useRef<NativeReviewDiffViewHandle>(null);
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
        headerInset={headerHeight}
        sectionId={selectedSection?.id ?? null}
        onSelectFile={handleSelectFile}
      />
    ),
    [handleSelectFile, headerHeight, nativeReviewDiffData.files, selectedSection?.id],
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

  const listHeader = useMemo(() => {
    const children: ReactElement[] = [];

    if (error) {
      children.push(
        <View key="review-error" className="border-b border-border bg-card px-4 py-3">
          <Text className="text-sm font-t3-bold text-foreground">Review unavailable</Text>
          <Text className="text-xs leading-[18px] text-foreground-muted">{error}</Text>
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
  const renderHeaderTitle = useCallback(
    () => (
      <ReviewHeaderTitle
        additions={headerDiffSummary.additions}
        deletions={headerDiffSummary.deletions}
        foregroundColor={headerForeground}
        mutedColor={headerMuted}
        pendingCommentCount={pendingReviewCommentCount}
        sectionTitle={selectedSection?.title ?? "Review changes"}
      />
    ),
    [
      headerDiffSummary.additions,
      headerDiffSummary.deletions,
      headerForeground,
      headerMuted,
      pendingReviewCommentCount,
      selectedSection?.title,
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
          headerTitle: renderHeaderTitle,
        }}
      />

      {layout.usesSplitView || showSectionToolbar || panes.supportsAuxiliaryPane ? (
        <Stack.Toolbar placement="right">
          {layout.usesSplitView ? (
            <Stack.Toolbar.Button
              accessibilityLabel={
                panes.primarySidebarVisible ? "Maximize review" : "Show thread sidebar"
              }
              icon={
                panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
              }
              onPress={togglePrimarySidebar}
              separateBackground
            />
          ) : null}
          {panes.supportsAuxiliaryPane ? (
            <Stack.Toolbar.Button
              accessibilityLabel={
                panes.auxiliaryPaneVisible ? "Hide changed files" : "Show changed files"
              }
              icon="sidebar.right"
              onPress={toggleAuxiliaryPane}
              separateBackground
            />
          ) : null}
          {showSectionToolbar ? (
            <Stack.Toolbar.Menu icon="ellipsis.circle" title="Select diff" separateBackground>
              <Stack.Toolbar.Menu inline>
                <Stack.Toolbar.MenuAction
                  disabled={sectionMenu.workingTree === null}
                  isOn={selectedSection?.id === sectionMenu.workingTree?.id}
                  onPress={() => {
                    if (sectionMenu.workingTree) {
                      selectSection(sectionMenu.workingTree.id);
                    }
                  }}
                >
                  <Stack.Toolbar.Label>Working tree</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
                <Stack.Toolbar.MenuAction
                  disabled={sectionMenu.branchChanges === null}
                  isOn={selectedSection?.id === sectionMenu.branchChanges?.id}
                  onPress={() => {
                    if (sectionMenu.branchChanges) {
                      selectSection(sectionMenu.branchChanges.id);
                    }
                  }}
                >
                  <Stack.Toolbar.Label>Branch changes</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
                <Stack.Toolbar.MenuAction
                  disabled={sectionMenu.latestTurn === null}
                  isOn={selectedSection?.id === sectionMenu.latestTurn?.id}
                  onPress={() => {
                    if (sectionMenu.latestTurn) {
                      selectSection(sectionMenu.latestTurn.id);
                    }
                  }}
                >
                  <Stack.Toolbar.Label>Latest turn</Stack.Toolbar.Label>
                </Stack.Toolbar.MenuAction>
                {sectionMenu.turns.length > 0 ? (
                  <Stack.Toolbar.Menu title="Turn">
                    {sectionMenu.turns.map((section) => (
                      <Stack.Toolbar.MenuAction
                        key={section.id}
                        isOn={section.id === selectedSection?.id}
                        onPress={() => selectSection(section.id)}
                        subtitle={section.subtitle ?? undefined}
                      >
                        <Stack.Toolbar.Label>{section.title}</Stack.Toolbar.Label>
                      </Stack.Toolbar.MenuAction>
                    ))}
                  </Stack.Toolbar.Menu>
                ) : null}
              </Stack.Toolbar.Menu>
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
          ) : null}
        </Stack.Toolbar>
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
        ) : selectedSection && parsedDiff.kind === "files" ? (
          <View
            className="flex-1"
            style={{
              backgroundColor: nativeBridge.theme.background,
            }}
          >
            <AdaptiveInspectorLayout renderInspector={renderInspector}>
              <View
                className="min-w-0 flex-1"
                style={{ paddingTop: topContentInset + REVIEW_HEADER_SPACING }}
              >
                {listHeader}
                <View className="min-w-0 flex-1" collapsable={false}>
                  <NativeReviewDiffView
                    collapsable={false}
                    testID="review-native-diff-view"
                    style={StyleSheet.absoluteFill}
                    appearanceScheme={selectedTheme}
                    collapsedFileIdsJson={nativeBridge.collapsedFileIdsJson}
                    collapsedCommentIdsJson={nativeBridge.collapsedCommentIdsJson}
                    contentResetKey={`${reviewCache.threadKey}:${selectedSection.id}`}
                    contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
                    nativeViewRef={nativeReviewDiffViewRef}
                    rowHeight={NATIVE_REVIEW_DIFF_ROW_HEIGHT}
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
            </AdaptiveInspectorLayout>
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
                <Text className="text-xs leading-[18px] text-foreground-muted">
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
                <Text className="text-xs leading-[18px] text-foreground-muted">
                  {selectedSection.subtitle ?? "This diff is empty."}
                </Text>
              </View>
            ) : parsedDiff.kind === "raw" ? (
              <View className="gap-3 border-b border-border bg-card px-4 py-4">
                <Text className="text-xs leading-[18px] text-foreground-muted">
                  {parsedDiff.reason}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
                  <Text selectable className="font-mono text-xs leading-[19px] text-foreground">
                    {parsedDiff.text}
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
