import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLocalSearchParams } from "expo-router";
import Stack from "expo-router/stack";
import { SymbolView } from "expo-symbols";
import { memo, type ReactElement, useCallback, useMemo } from "react";
import {
  ActivityIndicator,
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
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadDraftForThread } from "../../state/use-thread-composer-state";
import { useReviewCacheForThread } from "./reviewState";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
  NATIVE_REVIEW_DIFF_ROW_HEIGHT,
} from "./nativeReviewDiffAdapter";
import { useReviewDiffData } from "./useReviewDiffData";
import { useReviewFileVisibility } from "./reviewFileVisibility";
import { useReviewSections } from "./useReviewSections";
import { useNativeReviewDiffBridge } from "./useNativeReviewDiffBridge";
import { useReviewCommentSelectionController } from "./useReviewCommentSelectionController";

const IOS_NAV_BAR_HEIGHT = 44;
const REVIEW_HEADER_SPACING = 0;

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
      <Text className="text-[15px] font-t3-bold text-white">{props.title}</Text>
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

export function ReviewSheet() {
  const insets = useSafeAreaInsets();
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
  const selectedTheme = colorScheme === "dark" ? "dark" : "light";
  const topContentInset = insets.top + IOS_NAV_BAR_HEIGHT;
  const {
    error,
    loadingGitDiffs,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  } = useReviewSections({ environmentId, threadId, reviewCache });
  const { headerDiffSummary, nativeReviewDiffData, parsedDiff, pendingReviewCommentCount } =
    useReviewDiffData({
      threadKey: reviewCache.threadKey,
      selectedSection,
      draftMessage,
    });
  const NativeReviewDiffView = resolveNativeReviewDiffView()!;
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
              onPress={() => selectSection(section.id)}
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
          <View
            className="flex-1"
            style={{
              backgroundColor: nativeBridge.theme.background,
              paddingTop: topContentInset + REVIEW_HEADER_SPACING,
            }}
          >
            {listHeader}
            <View className="flex-1" collapsable={false}>
              <NativeReviewDiffView
                key={`${reviewCache.threadKey}:${selectedSection.id}`}
                collapsable={false}
                testID="review-native-diff-view"
                style={StyleSheet.absoluteFill}
                appearanceScheme={selectedTheme}
                collapsedFileIdsJson={nativeBridge.collapsedFileIdsJson}
                collapsedCommentIdsJson={nativeBridge.collapsedCommentIdsJson}
                contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
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
                onToggleComment={nativeBridge.onToggleComment}
                onToggleFile={handleNativeToggleFile}
                onToggleViewedFile={handleNativeToggleViewedFile}
              />
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
          bottomInset={insets.bottom}
          title={commentSelection.selectionAction?.title ?? null}
          onOpenComment={commentSelection.selectionAction?.onOpenComment ?? null}
          onClear={commentSelection.clearSelection}
        />
      </View>
    </>
  );
}
