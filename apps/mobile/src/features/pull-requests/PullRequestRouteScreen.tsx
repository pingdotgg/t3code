import { Chip } from "../../components/Chip";
import { pullRequestTabOffset } from "./pullRequestTabScroll";
import { guideFocusedRows, type GuideDiffFocus } from "./guide/guideDiffFocus";
import { PullRequestGuideContent } from "./guide/PullRequestGuideScreen";
import { useReviewGuidesEnabled } from "./guide/useReviewGuide";
import {
  filterPullRequestActivity,
  DEFAULT_ACTIVITY_FILTER,
  type ActivityFilter,
} from "./pullRequestActivityFilter";
import { PullRequestActivityFilters } from "./PullRequestActivityFilters";
import type { LegendListRef } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import Animated from "react-native-reanimated";
import {
  PR_ROW_LAYOUT,
  PR_ROW_ENTER,
  PR_ROW_EXIT,
  PR_POSITION_LAYOUT,
} from "./pullRequestAnimations";
import {
  canPerformPullRequestAction,
  openOnProviderLabel,
  PR_ACTION_ICONS,
  PR_ACTION_LABELS,
} from "./pullRequestActions";
import * as Clipboard from "expo-clipboard";
import { Menu } from "../../components/Menu";
import { IconButton } from "../../components/IconButton";
import { Button } from "../../components/Button";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { usePullRequestAction } from "./usePullRequestAction";
import { annotatePullRequestDiff, reviewPosition } from "./pullRequestDiffComments";
import { usePullRequestFileFilter } from "./usePullRequestFileFilter";
import { isPullRequestTestFile } from "./pullRequestFileFilters";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  useRoute,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useAtomRefresh } from "@effect/atom-react";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";
import { type PullRequestDetail, type PullRequestListEntry } from "@t3tools/contracts";
import { PullRequestOverviewLoading } from "./PullRequestOverviewLoading";
import { pullRequestStatus } from "./pullRequestStatus";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  type ScrollViewProps,
  StyleSheet,
  View,
} from "react-native";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";
import { EmptyState } from "../../components/EmptyState";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SymbolView } from "../../components/AppSymbol";
import { relativeTime } from "../../lib/time";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import {
  isNativeReviewDiffDrawEvent,
  resolveNativeReviewDiffView,
  type NativeReviewDiffViewHandle,
  type NativeReviewDiffViewProps,
} from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
import { pullRequestTimelineRows } from "./PullRequestTimeline";
import { PullRequestActionToolbar, PullRequestCardGroup } from "./PullRequestControls";
import {
  pullRequestTarget as requestTarget,
  usePullRequestDiff,
  type PullRequestDiffParams,
  type PullRequestParams,
} from "./usePullRequestDiff";
import {
  PullRequestAvatar,
  PullRequestDiffStats,
  PullRequestReadStatus,
} from "./PullRequestPresentation";
import { PullRequestFiles, usePullRequestFilesContent } from "./PullRequestFiles";
import { PullRequestSheetContent } from "./PullRequestSheetContent";
import { PullRequestDescription } from "./PullRequestDescription";
import { PullRequestMarkdownRepository } from "./PullRequestMarkdown";
import {
  PullRequestStatusMenu,
  PullRequestChecksRow,
  PullRequestBranchRow,
  PullRequestReviewersRow,
} from "./PullRequestStatusRows";
import { PullRequestMergeControls } from "./PullRequestMergeControls";
import { PullRequestStackCard } from "./PullRequestStackCard";
import { usePullRequestStack, type PullRequestStackState } from "./usePullRequestStack";
import { usePullRequestEnvironmentFallback } from "./usePullRequestEnvironmentFallback";

const EMPTY_IDS: readonly string[] = [];

function PullRequestTabScrollView(props: ScrollViewProps) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollViewMarker style={{ flex: 1 }}>
      <ScrollView
        {...props}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </ScrollViewMarker>
  );
}

function usePullRequestActivityRows(params: PullRequestParams, filter: ActivityFilter) {
  const navigation = useNavigation();
  const result = useEnvironmentQuery(composerPullRequests.activity(requestTarget(params)));
  const filtered = useMemo(
    () => (result.data ? filterPullRequestActivity(result.data, filter) : null),
    [result.data, filter],
  );
  const rows = useMemo(() => {
    if (!filtered) return [];
    const rows = pullRequestTimelineRows(filtered.activity, params, navigation);
    if (filter.newestFirst) {
      const notice = rows.at(-1)?.key === "truncated" ? rows.pop() : undefined;
      rows.reverse();
      if (notice) rows.push(notice);
    }
    if (!rows.length)
      rows.push({
        key: "empty",
        date: "",
        content: (
          <Text className="py-6 text-sm text-foreground-muted">
            No activity matches these filters.
          </Text>
        ),
      });
    return rows;
  }, [filtered, filter.newestFirst, params, navigation]);
  return {
    rows,
    hiddenCount: filtered?.hiddenCount ?? 0,
    pending: result.isPending,
    error: result.error,
  };
}

function PullRequestIdentity(props: {
  readonly pr: PullRequestDetail | PullRequestListEntry;
  readonly params: PullRequestParams;
}) {
  const { pr } = props;
  const status = pullRequestStatus(pr);
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-2">
        {"capabilities" in pr ? (
          <PullRequestStatusMenu pr={pr} params={props.params} />
        ) : (
          <View className="min-h-8 flex-row items-center gap-1.5">
            <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
            <Text className={`text-xs font-t3-medium ${status.text}`}>{status.label}</Text>
          </View>
        )}
        <PullRequestDiffStats additions={pr.additions} deletions={pr.deletions} compact />
        {"changedFiles" in pr ? (
          <Text className="text-2xs text-foreground-muted">
            {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
          </Text>
        ) : (
          <View className="h-3 w-12 rounded bg-subtle-strong" />
        )}
      </View>
      <Text selectable className="text-xl font-t3-bold leading-7">
        {pr.title}
      </Text>
      <View className="flex-row items-center gap-2">
        <PullRequestAvatar actor={pr.author} size={20} />
        <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>
          {pr.author?.login ?? "Unknown author"}
        </Text>
        <Text className="shrink text-right text-2xs text-foreground-muted" numberOfLines={1}>
          Updated {relativeTime(pr.updatedAt)} ago
        </Text>
      </View>
      <View className="flex-row items-start gap-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy base branch ${pr.baseBranch}`}
          onPress={() => void Clipboard.setStringAsync(pr.baseBranch)}
          className="min-w-0 shrink active:opacity-70"
          hitSlop={8}
        >
          <Text className="font-mono text-2xs text-foreground-muted">{pr.baseBranch}</Text>
        </Pressable>
        <View className="pt-0.5">
          <SymbolView name="arrow.left" size={11} tintColorClassName="accent-icon-muted" />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Copy head branch ${pr.headBranch}`}
          onPress={() => void Clipboard.setStringAsync(pr.headBranch)}
          className="min-w-0 shrink active:opacity-70"
          hitSlop={8}
        >
          <Text className="font-mono text-2xs text-foreground-muted">{pr.headBranch}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function PullRequestOverview(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
  readonly onDescriptionLayout: (y: number) => void;
  readonly onDescriptionCollapse: () => void;
  readonly descriptionExpanded: boolean;
  readonly onDescriptionExpandedChange: (expanded: boolean) => void;
}) {
  const { pr } = props;
  return (
    <View className="gap-5">
      <PullRequestStackCard params={props.params} state={props.stack} />
      <PullRequestCardGroup>
        <PullRequestChecksRow pr={pr} params={props.params} />
        <PullRequestReviewersRow pr={pr} params={props.params} />
        <Animated.View layout={PR_ROW_LAYOUT}>
          <PullRequestBranchRow pr={pr} params={props.params} />
        </Animated.View>
        <Animated.View layout={PR_ROW_LAYOUT}>
          <PullRequestMergeControls pr={pr} params={props.params} stack={props.stack} />
        </Animated.View>
      </PullRequestCardGroup>
      {pr.labels.length ? (
        <Animated.View layout={PR_ROW_LAYOUT} className="flex-row flex-wrap gap-2">
          {pr.labels.map((label) => (
            <Chip key={label.name} label={label.name} size="small" />
          ))}
        </Animated.View>
      ) : null}
      <Animated.View
        layout={PR_POSITION_LAYOUT}
        onLayout={(event) => props.onDescriptionLayout(event.nativeEvent.layout.y)}
      >
        <PullRequestDescription
          markdown={pr.body}
          onCollapse={props.onDescriptionCollapse}
          expanded={props.descriptionExpanded}
          onExpandedChange={props.onDescriptionExpandedChange}
        />
      </Animated.View>
    </View>
  );
}

function usePullRequestToolbarHeight(bottomInset: number) {
  const { buttonSize } = useAndroidControlSizing();
  // Reserve the controls, native toolbar padding, and outer gaps before onLayout measures them.
  return useState(() => (Platform.OS === "android" ? bottomInset + buttonSize + 40 : 0));
}

export function PullRequestRouteScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const returnToList = useAndroidWorkspaceBack("pullRequests");
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [toolbarHeight, setToolbarHeight] = usePullRequestToolbarHeight(insets.bottom);
  const params = route.params;
  usePullRequestEnvironmentFallback(params);
  const connected = usePullRequestConnected(params.environmentId);
  const [section, setSection] = useState<"overview" | "activity" | "guide">("overview");
  // Keep each tab's native list and measured rows alive when it is hidden.
  const requestedSection = useRef(section);
  const [listAnimationsReady, setListAnimationsReady] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const filesContent = usePullRequestFilesContent({ params });
  const guidesEnabled = useReviewGuidesEnabled(params);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(DEFAULT_ACTIVITY_FILTER);
  const activityContent = usePullRequestActivityRows(params, activityFilter);
  const scrollOffsets = useRef<Record<string, number>>({});
  const currentScrollOffset = useRef(-insets.top);
  const bodyY = useRef(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollViews = useRef<Partial<Record<typeof section, LegendListRef | null>>>({});
  const selectSection = (next: typeof section) => {
    if (next === section) return;
    scrollOffsets.current[section] = currentScrollOffset.current;
    const headerEnd = Math.max(-insets.top, bodyY.current - insets.top);
    // The shared header stays in place. Once collapsed, retain each tab's own reading position.
    const offset = pullRequestTabOffset(
      currentScrollOffset.current,
      scrollOffsets.current[next],
      headerEnd,
    );
    requestedSection.current = next;
    scrollOffsets.current[next] = offset;
    currentScrollOffset.current = offset;
    scrollViews.current[next]?.scrollToOffset({ offset, animated: false });
    setSection(next);
  };
  useEffect(() => {
    if (!guidesEnabled && section === "guide") {
      requestedSection.current = "overview";
      currentScrollOffset.current = scrollOffsets.current.overview ?? -insets.top;
      setSection("overview");
    }
  }, [guidesEnabled, section, insets.top]);
  const tabContent = activityContent;
  const filesY = useRef(0);
  const descriptionY = useRef(0);
  const pendingDescriptionJump = useRef(false);
  const pendingFilesJump = useRef(false);
  const detailAtom = composerPullRequests.detail(requestTarget(params));
  const result = useEnvironmentQuery(detailAtom);
  const pullRefresh = usePullToRefresh(detailAtom);
  const { refresh: refreshDetail } = result;
  useFocusEffect(useCallback(() => refreshDetail(), [refreshDetail]));
  const pr = result.data;
  const summary = params.initialSummary;
  const identity = pr ?? summary;
  const permissions = usePullRequestPermissions(params, pr);
  const action = usePullRequestAction(params, pr);
  const showsDeleteBranch = pr !== null && canPerformPullRequestAction(pr, "delete-branch");
  const confirmDeleteBranch = () =>
    pr &&
    action.confirm(
      "delete-branch",
      PR_ACTION_LABELS["delete-branch"],
      `Delete ${pr.headBranch} from ${pr.headRepositoryNameWithOwner ?? pr.repository}? Local branches and worktrees are not changed.`,
    );
  const stack = usePullRequestStack(params, pr);
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(requestTarget(params)));
  const refreshGuide = useAtomRefresh(composerPullRequests.reviewGuide(requestTarget(params)));
  const refresh = () => {
    pullRefresh.onRefresh();
    if (guidesEnabled) refreshGuide();
    stack.refresh();
    refreshActivity();
    filesContent.refresh();
  };
  const jumpToFiles = () => {
    scrollViews.current.overview?.scrollToOffset({
      offset: bodyY.current + filesY.current - insets.top,
      animated: true,
    });
    pendingFilesJump.current = false;
  };
  const openFiles = () => {
    if (section === "overview") jumpToFiles();
    else {
      pendingFilesJump.current = true;
      selectSection("overview");
      if (filesY.current > 0) requestAnimationFrame(jumpToFiles);
    }
  };
  return (
    <PullRequestMarkdownRepository
      params={params}
      value={pr?.provider === "github" ? pr.url : null}
    >
      <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
        <NativeStackScreenOptions
          options={{
            title: `#${params.number}`,
            headerTitle: `#${params.number}`,
            unstable_headerSubtitle: connected
              ? params.repository
              : `${params.repository} · Offline`,
          }}
        />
        {Platform.OS === "android" ? (
          <AndroidScreenHeader
            title={`#${params.number}${connected ? "" : " · Offline"}`}
            subtitle={params.repository}
            onBack={layout.usesSplitView ? undefined : returnToList}
            leading={layout.usesSplitView ? <AndroidWorkspaceSidebarButton /> : undefined}
            actions={[
              ...(permissions.verdicts.length
                ? [
                    {
                      accessibilityLabel: "Submit review",
                      icon: "text.bubble" as const,
                      onPress: () =>
                        navigation.navigate("PullRequestReview", { ...params, mode: "review" }),
                    },
                  ]
                : []),
              ...(permissions.canComment
                ? [
                    {
                      accessibilityLabel: "Add comment",
                      icon: "plus.bubble" as const,
                      onPress: () =>
                        navigation.navigate("PullRequestReview", { ...params, mode: "comment" }),
                    },
                  ]
                : []),
              ...(pr
                ? [
                    {
                      accessibilityLabel: openOnProviderLabel(pr.provider),
                      icon: "arrow.up.right" as const,
                      onPress: () => void Linking.openURL(pr.url),
                    },
                  ]
                : []),
              ...(showsDeleteBranch
                ? [
                    {
                      accessibilityLabel: PR_ACTION_LABELS["delete-branch"],
                      icon: PR_ACTION_ICONS["delete-branch"],
                      disabled: !action.available("delete-branch"),
                      destructive: true,
                      overflowOnly: true,
                      onPress: confirmDeleteBranch,
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Menu
            title="Pull request"
            accessibilityLabel="Pull request actions"
            icon="ellipsis"
          >
            {permissions.verdicts.length ? (
              <NativeHeaderToolbar.MenuAction
                icon="text.bubble"
                onPress={() =>
                  navigation.navigate("PullRequestReview", { ...params, mode: "review" })
                }
              >
                <NativeHeaderToolbar.Label>Submit review</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ) : null}
            {permissions.canComment ? (
              <NativeHeaderToolbar.MenuAction
                icon="plus.bubble"
                onPress={() =>
                  navigation.navigate("PullRequestReview", { ...params, mode: "comment" })
                }
              >
                <NativeHeaderToolbar.Label>Add comment</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ) : null}
            {pr ? (
              <NativeHeaderToolbar.MenuAction
                icon="arrow.up.right"
                onPress={() => void Linking.openURL(pr.url)}
              >
                <NativeHeaderToolbar.Label>
                  {openOnProviderLabel(pr.provider)}
                </NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ) : null}
            {showsDeleteBranch ? (
              <NativeHeaderToolbar.MenuAction
                icon={PR_ACTION_ICONS["delete-branch"]}
                destructive
                disabled={!action.available("delete-branch")}
                subtitle={
                  action.busy
                    ? "Deleting…"
                    : connected
                      ? pr.headBranch
                      : "Reconnect to delete this branch."
                }
                onPress={confirmDeleteBranch}
              >
                <NativeHeaderToolbar.Label>
                  {PR_ACTION_LABELS["delete-branch"]}
                </NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ) : null}
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
        <View
          style={{
            flex: 1,
            marginHorizontal: Platform.OS === "android" && layout.usesSplitView ? 4 : 0,
          }}
          className={
            Platform.OS === "android"
              ? "overflow-hidden rounded-t-[28px] bg-sheet-solid"
              : undefined
          }
          onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        >
          {(["overview", "guide", "activity"] as const)
            .filter((tab) => tab !== "guide" || guidesEnabled)
            .map((tab) => (
              <View
                key={tab}
                style={[StyleSheet.absoluteFill, { opacity: section === tab ? 1 : 0 }]}
                pointerEvents={section === tab ? "auto" : "none"}
                accessibilityElementsHidden={section !== tab}
                importantForAccessibility={section === tab ? "auto" : "no-hide-descendants"}
              >
                <AnimatedLegendList
                  ref={(list) => {
                    scrollViews.current[tab] = list;
                  }}
                  initialScrollOffset={-insets.top}
                  onScroll={(event) => {
                    const offset = event.nativeEvent.contentOffset.y;
                    scrollOffsets.current[tab] = offset;
                    if (requestedSection.current === tab) currentScrollOffset.current = offset;
                  }}
                  className="flex-1"
                  renderScrollComponent={
                    Platform.OS === "ios" ? PullRequestTabScrollView : undefined
                  }
                  contentInsetAdjustmentBehavior="never"
                  contentInset={
                    Platform.OS === "ios" ? { top: insets.top, bottom: insets.bottom } : undefined
                  }
                  contentInsetStartAdjustment={Platform.OS === "ios" ? insets.top : 0}
                  refreshControl={
                    <RefreshControl
                      refreshing={section === tab && pullRefresh.refreshing}
                      onRefresh={refresh}
                    />
                  }
                  alwaysBounceVertical
                  scrollsToTop={section === tab}
                  onContentSizeChange={() => {
                    if (
                      tab !== "overview" ||
                      section !== "overview" ||
                      !pendingDescriptionJump.current
                    )
                      return;
                    pendingDescriptionJump.current = false;
                    // Collapse changes the scroll range; restore the heading after that layout commits.
                    scrollViews.current.overview?.scrollToOffset({
                      offset: bodyY.current + descriptionY.current - insets.top,
                      animated: false,
                    });
                  }}
                  contentContainerStyle={{
                    paddingHorizontal: 16,
                    paddingTop: 8,
                    paddingBottom: 24 + (Platform.OS === "android" ? toolbarHeight : 0),
                    // Short tabs must still be tall enough to preserve the collapsed header.
                    minHeight: Math.max(
                      0,
                      viewportHeight + headerHeight - insets.top - insets.bottom,
                    ),
                  }}
                  data={[
                    {
                      key: `${tab}:body`,
                      content: (
                        <View>
                          {tab === "overview" && identity ? (
                            <View>
                              {pr ? (
                                <PullRequestOverview
                                  pr={pr}
                                  params={params}
                                  stack={stack}
                                  descriptionExpanded={descriptionExpanded}
                                  onDescriptionExpandedChange={setDescriptionExpanded}
                                  onDescriptionLayout={(y) => {
                                    descriptionY.current = y;
                                  }}
                                  onDescriptionCollapse={() => {
                                    pendingDescriptionJump.current = true;
                                  }}
                                />
                              ) : summary ? (
                                <PullRequestOverviewLoading
                                  summary={summary}
                                  params={params}
                                  stack={stack}
                                />
                              ) : null}
                              <View
                                className="mt-8 border-t border-border-subtle pt-3"
                                onLayout={(event) => {
                                  filesY.current = event.nativeEvent.layout.y;
                                  if (pendingFilesJump.current) {
                                    requestAnimationFrame(() => {
                                      if (requestedSection.current === "overview") jumpToFiles();
                                    });
                                  }
                                }}
                              >
                                {filesContent.header}
                              </View>
                            </View>
                          ) : null}
                          {tab === "guide" ? <PullRequestGuideContent params={params} /> : null}
                          {tab === "activity" ? (
                            <PullRequestActivityFilters
                              value={activityFilter}
                              onChange={setActivityFilter}
                              hiddenCount={tabContent.hiddenCount}
                            />
                          ) : null}
                          {tab === "activity" ? (
                            <PullRequestReadStatus
                              pending={tabContent.pending}
                              error={tabContent.error}
                            />
                          ) : null}
                        </View>
                      ),
                    },
                    ...(tab === "overview"
                      ? identity
                        ? filesContent.rows
                        : []
                      : tab === "activity"
                        ? tabContent.rows
                        : []
                    ).map((row) => ({
                      ...row,
                      key: `${tab}:${row.key}`,
                      content: row.content,
                    })),
                  ]}
                  keyExtractor={(row) => row.key}
                  getItemType={(row) =>
                    row.key.endsWith(":body") ? row.key : row.key.split(":")[0]
                  }
                  // The overview body contains the clipped description and owns collapse scroll
                  // correction. Animating that cell fights both; file rows still fade individually.
                  itemLayoutAnimation={tab === "overview" ? undefined : PR_ROW_LAYOUT}
                  onLoad={() => setListAnimationsReady(true)}
                  renderItem={({ item }) => (
                    <Animated.View
                      key={item.key}
                      entering={
                        listAnimationsReady && !item.key.endsWith(":body")
                          ? PR_ROW_ENTER
                          : undefined
                      }
                      exiting={
                        listAnimationsReady && !item.key.endsWith(":body") ? PR_ROW_EXIT : undefined
                      }
                    >
                      {item.content}
                    </Animated.View>
                  )}
                  recycleItems={false}
                  estimatedItemSize={tab === "overview" ? 64 : 220}
                  maintainVisibleContentPosition={false}
                  ListHeaderComponent={
                    <>
                      <PullRequestReadStatus
                        pending={result.isPending && !identity}
                        error={result.error}
                      />
                      {identity ? (
                        <View
                          className="gap-5 pb-5"
                          onLayout={(event) => {
                            bodyY.current = event.nativeEvent.layout.height;
                            setHeaderHeight(event.nativeEvent.layout.height);
                          }}
                        >
                          <PullRequestIdentity pr={identity} params={params} />
                          <SegmentedControl
                            className={Platform.OS === "android" ? undefined : "bg-grouped-card"}
                            options={[
                              { value: "overview", label: "Overview" },
                              ...(guidesEnabled
                                ? [{ value: "guide" as const, label: "Guide" }]
                                : []),
                              { value: "activity", label: "Activity" },
                            ]}
                            selected={section}
                            onSelect={selectSection}
                            role="tab"
                            size="compact"
                          />
                        </View>
                      ) : null}
                    </>
                  }
                  ListFooterComponent={tab === "overview" ? filesContent.footer : null}
                />
              </View>
            ))}
        </View>
        <PullRequestActionToolbar
          pr={pr}
          params={params}
          onOpenFiles={openFiles}
          onHeightChange={setToolbarHeight}
        />
      </View>
    </PullRequestMarkdownRepository>
  );
}

export function PullRequestFilesRouteScreen({ route }: StaticScreenProps<PullRequestDiffParams>) {
  const navigation = useNavigation();
  const fileSelectionId = useRoute().key;
  return (
    <PullRequestSheetContent
      title="Changed files"
      scrollable={false}
      subtitle={`#${route.params.number}${route.params.commit ? ` · ${route.params.commit.slice(0, 7)}` : ` · ${route.params.repository}`}`}
    >
      <PullRequestFiles
        params={route.params}
        groupByDirectory
        onSelectFile={(path) =>
          navigation.dispatch(
            StackActions.popTo("PullRequestFile", {
              ...route.params,
              path,
              fileSelectionId,
            }),
          )
        }
      />
    </PullRequestSheetContent>
  );
}

export function PullRequestFileRouteScreen({
  route,
}: StaticScreenProps<
  PullRequestDiffParams & {
    readonly path: string;
    readonly fileSelectionId?: string;
    readonly replacingDraftId?: string;
    readonly focus?: GuideDiffFocus;
  }
>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [toolbarHeight, setToolbarHeight] = usePullRequestToolbarHeight(insets.bottom);
  const commit = route.params.commit;
  const result = usePullRequestDiff(route.params);
  const filter = usePullRequestFileFilter(
    result.parsed,
    route.params.focus ? route.params.path : undefined,
  );
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(route.params)));
  const { refresh: refreshDetail } = detail;
  useFocusEffect(useCallback(() => refreshDetail(), [refreshDetail]));
  const { loadMore } = result;
  const parsed = filter.parsed;
  const reviewDraft = usePullRequestReviewDraft(route.params);
  const viewed = usePullRequestFilesViewed(route.params, commit ? null : detail.data);
  const [commitViewedPaths, setCommitViewedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const permissions = usePullRequestPermissions(route.params, detail.data);
  const scopeKey = pullRequestReviewKey(route.params);
  const [diffHead, setDiffHead] = useState({ scopeKey, sha: detail.data?.headSha ?? null });
  if (diffHead.scopeKey !== scopeKey || (!diffHead.sha && detail.data?.headSha))
    setDiffHead({ scopeKey, sha: detail.data?.headSha ?? null });
  const staleDiff = Boolean(
    !commit && diffHead.sha && detail.data?.headSha && diffHead.sha !== detail.data.headSha,
  );
  const canCommentOnDiff =
    permissions.canInlineComment &&
    !commit &&
    !staleDiff &&
    !detail.isPending &&
    !result.isPending &&
    !result.error;
  const activity = useEnvironmentQuery(composerPullRequests.activity(requestTarget(route.params)));
  const baseData = useMemo(() => buildNativeReviewDiffData(parsed), [parsed]);
  const data = useMemo(
    () =>
      annotatePullRequestDiff(
        baseData,
        staleDiff || commit ? [] : (activity.data?.reviewThreads ?? []),
        commit ? [] : reviewDraft.draft.comments,
        diffHead.sha ?? undefined,
      ),
    [baseData, activity.data, reviewDraft.draft.comments, diffHead.sha, staleDiff, commit],
  );
  const viewedIds = data.files
    .filter((file) => (commit ? commitViewedPaths.has(file.path) : viewed.isViewed(file.path)))
    .map((file) => file.id);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const selectedRow = data.rows.find((row) => row.id === selectedRowId);
  const selectedFile = data.files.find((file) => file.id === selectedRow?.fileId);
  const commentOnLine = (rowId = selectedRowId) => {
    const row = data.rows.find((row) => row.id === rowId);
    const file = data.files.find((file) => file.id === row?.fileId);
    if (!row || !file || !diffHead.sha || !canCommentOnDiff) return;
    const position = reviewPosition(row);
    if (!position) return;
    const oldPath =
      parsed.kind === "files"
        ? parsed.files.find((entry) => entry.id === file.id)?.previousPath
        : null;
    if (route.params.replacingDraftId) navigation.setParams({ replacingDraftId: undefined });
    navigation.navigate("PullRequestInlineComment", {
      ...route.params,
      ...(route.params.replacingDraftId ? { draftId: route.params.replacingDraftId } : {}),
      path: file.path,
      ...(oldPath ? { oldPath } : {}),
      position,
      headSha: diffHead.sha,
      code: row.content ?? "",
    });
  };
  const [jumpPath, setJumpPath] = useState(route.params.path);
  const requestedFile =
    result.parsed.kind === "files"
      ? result.parsed.files.find((file) => file.path === jumpPath)
      : undefined;
  const targetFile =
    data.files.find((file) => file.path === jumpPath) ??
    (!jumpPath || requestedFile ? data.files[0] : undefined);
  const focus = route.params.focus;
  const focusedRows = guideFocusedRows(data.rows, targetFile?.id, focus);
  const focusIndex = focusedRows.length
    ? data.rows.findIndex((row) => row.id === focusedRows[0]?.id)
    : -1;
  const [collapsedIds, setCollapsedIds] = useState<readonly string[]>(EMPTY_IDS);
  const [visibleFileId, setVisibleFileId] = useState<string | null>(null);
  const nativeView = useRef<NativeReviewDiffViewHandle>(null);
  const jumpStarted = useRef(false);
  const lastSelection = useRef({ path: route.params.path, id: route.params.fileSelectionId });
  // Each sheet selection jumps in this reader, including reselecting its original file.
  useEffect(() => {
    if (
      lastSelection.current.path === route.params.path &&
      lastSelection.current.id === route.params.fileSelectionId
    )
      return;
    lastSelection.current = { path: route.params.path, id: route.params.fileSelectionId };
    if (route.params.focus) navigation.setParams({ focus: undefined });
    setJumpPath(route.params.path);
    setSelectedRowId(null);
    jumpStarted.current = false;
    const file = data.files.find((entry) => entry.path === route.params.path);
    if (!file || !nativeView.current) return;
    setCollapsedIds((ids) => ids.filter((id) => id !== file.id));
    jumpStarted.current = true;
    void nativeView.current.scrollToFile(file.id, false).catch(() => {
      jumpStarted.current = false;
    });
  }, [route.params.path, route.params.fileSelectionId, route.params.focus, data.files, navigation]);
  const appliedFilter = useRef(filter.hideTestFiles);
  useEffect(() => {
    if (appliedFilter.current === filter.hideTestFiles) return;
    appliedFilter.current = filter.hideTestFiles;
    if (
      result.parsed.kind === "files" &&
      result.parsed.files.some((file) => isPullRequestTestFile(file.path))
    ) {
      jumpStarted.current = false;
    }
  }, [filter.hideTestFiles, result.parsed]);
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance, appearance, setCodeWordBreak } = useAppearancePreferences();
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId: `pull-request:${route.params.repository}:${route.params.number}:${commit ?? "all"}`,
    diff: result.patch,
    data,
    collapsedFileIds: collapsedIds,
    viewedFileIds: viewedIds,
    selectedRowIds: selectedRowId ? [selectedRowId] : focusedRows.map((row) => row.id),
    canHighlight: true,
  });
  const [NativeDiffView] = useState(() => resolveNativeReviewDiffView());
  // A file picked from a later page must be fetched before we can jump to its header.
  useEffect(() => {
    if (!targetFile) loadMore();
  }, [targetFile, loadMore]);
  const { onDebug: updateVisibleRange } = bridge;
  const onDebug = useCallback<NonNullable<NativeReviewDiffViewProps["onDebug"]>>(
    (event) => {
      const drawn = isNativeReviewDiffDrawEvent(event.nativeEvent);
      const decoded =
        event.nativeEvent.message === "rows-decoded" && event.nativeEvent.rows === data.rows.length;
      if (!drawn && !decoded) return;
      // Filtering replaces the native row payload asynchronously. Old draw events
      // must not consume the file jump or highlight the new payload's row indices.
      if (
        typeof event.nativeEvent.totalRows === "number" &&
        event.nativeEvent.totalRows !== data.rows.length
      )
        return;
      if (drawn) updateVisibleRange(event);
      if (
        targetFile &&
        !jumpStarted.current &&
        nativeView.current &&
        (Platform.OS !== "ios" || decoded)
      ) {
        jumpStarted.current = true;
        if (focusIndex >= 0) return;
        void nativeView.current.scrollToFile(targetFile.id, false).catch(() => {
          jumpStarted.current = false;
        });
        return;
      }
      if (!drawn) return;
      const lastRow = event.nativeEvent.lastRowIndex;
      if (typeof lastRow === "number" && lastRow >= data.rows.length - 40) loadMore();
    },
    [updateVisibleRange, data.rows.length, loadMore, targetFile, focusIndex],
  );
  const onToggleFile = useCallback<NonNullable<NativeReviewDiffViewProps["onToggleFile"]>>(
    (event) => {
      const id = event.nativeEvent.fileId;
      if (!id) return;
      setCollapsedIds((ids) =>
        ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
      );
    },
    [],
  );
  const visibleFile = data.files.find((file) => file.id === visibleFileId) ?? targetFile;
  const toggleTestFiles = () => {
    setJumpPath(visibleFile?.path ?? route.params.path);
    setSelectedRowId(null);
    filter.toggle();
  };
  const title = commit ? "Commit changes" : "Changes";
  const seekingFile = !targetFile && result.nextCursor !== null;
  const loadingDiff = (result.isPending && !data.rows.length) || (seekingFile && !result.error);
  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      <NativeStackScreenOptions
        options={{
          title,
          headerTitle: title,
          unstable_headerSubtitle: `${commit ? commit.slice(0, 7) : `#${route.params.number}`} · ${data.files.length} ${data.files.length === 1 ? "file" : "files"}${filter.hideTestFiles && filter.hiddenCount ? ` · ${filter.hiddenCount} ${filter.hiddenCount === 1 ? "test" : "tests"} hidden` : ""}`,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          onBack={() => navigation.goBack()}
          trailing={
            <Menu
              actions={[
                {
                  id: "word-wrap",
                  title: "Word wrap",
                  image: "text.alignleft",
                  state: appearance.codeWordBreak ? "on" : "off",
                },
                {
                  id: "hide-tests",
                  title: "Hide test files",
                  image: "line.3.horizontal.decrease",
                  state: filter.hideTestFiles ? "on" : "off",
                },
                ...(permissions.verdicts.length
                  ? [{ id: "submit-review", title: "Submit review", image: "text.bubble" }]
                  : []),
                ...(permissions.canComment
                  ? [{ id: "comment-on-pr", title: "Add comment", image: "plus.bubble" }]
                  : []),
                ...(selectedRow && selectedFile
                  ? [
                      ...(canCommentOnDiff ? [{ id: "comment", title: "Add review comment" }] : []),
                      { id: "copy", title: "Copy line" },
                    ]
                  : []),
              ]}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "word-wrap") setCodeWordBreak(!appearance.codeWordBreak);
                else if (nativeEvent.event === "hide-tests") toggleTestFiles();
                else if (
                  nativeEvent.event === "submit-review" ||
                  nativeEvent.event === "comment-on-pr"
                )
                  navigation.navigate("PullRequestReview", {
                    ...route.params,
                    mode: nativeEvent.event === "submit-review" ? "review" : "comment",
                  });
                else if (nativeEvent.event === "comment") commentOnLine();
                else void Clipboard.setStringAsync(selectedRow?.content ?? "");
              }}
            >
              <View pointerEvents="none">
                <IconButton icon="ellipsis" accessibilityLabel="Diff options" />
              </View>
            </Menu>
          }
        />
      ) : null}
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Menu
          title="Diff options"
          accessibilityLabel="Diff options"
          icon="ellipsis"
        >
          {permissions.verdicts.length ? (
            <NativeHeaderToolbar.MenuAction
              icon="text.bubble"
              onPress={() =>
                navigation.navigate("PullRequestReview", { ...route.params, mode: "review" })
              }
            >
              <NativeHeaderToolbar.Label>Submit review</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
          {permissions.canComment ? (
            <NativeHeaderToolbar.MenuAction
              icon="plus.bubble"
              onPress={() =>
                navigation.navigate("PullRequestReview", { ...route.params, mode: "comment" })
              }
            >
              <NativeHeaderToolbar.Label>Add comment</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
          <NativeHeaderToolbar.MenuAction
            icon="text.alignleft"
            isOn={appearance.codeWordBreak}
            onPress={() => setCodeWordBreak(!appearance.codeWordBreak)}
          >
            <NativeHeaderToolbar.Label>Word wrap</NativeHeaderToolbar.Label>
          </NativeHeaderToolbar.MenuAction>
          <NativeHeaderToolbar.MenuAction
            icon="line.3.horizontal.decrease"
            isOn={filter.hideTestFiles}
            onPress={toggleTestFiles}
          >
            <NativeHeaderToolbar.Label>Hide test files</NativeHeaderToolbar.Label>
          </NativeHeaderToolbar.MenuAction>
          {selectedRow && selectedFile && canCommentOnDiff ? (
            <NativeHeaderToolbar.MenuAction icon="bubble.left" onPress={() => commentOnLine()}>
              <NativeHeaderToolbar.Label>
                {route.params.replacingDraftId ? "Move draft to this line" : "Add review comment"}
              </NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
          {selectedRow && selectedFile ? (
            <NativeHeaderToolbar.MenuAction
              icon="document.on.document"
              onPress={() => void Clipboard.setStringAsync(selectedRow.content ?? "")}
            >
              <NativeHeaderToolbar.Label>Copy line</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ) : null}
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
      {route.params.replacingDraftId ? (
        <Text className="px-4 py-2 text-xs text-foreground-muted">
          Select a current line, then choose “Move draft to this line” from its menu.
        </Text>
      ) : null}
      {viewed.error ? (
        <Text className="px-4 py-2 text-xs text-danger-foreground">{viewed.error}</Text>
      ) : null}
      {staleDiff ? (
        <View
          className="flex-row items-center gap-2 px-4 py-2"
          style={{ paddingTop: Platform.OS === "ios" ? insets.top + 8 : 8 }}
        >
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            The branch changed. Reload before adding line comments.
          </Text>
          <Button
            label="Reload changes"
            onPress={() => {
              result.refresh();
              setDiffHead({ scopeKey, sha: detail.data?.headSha ?? null });
              jumpStarted.current = false;
              setSelectedRowId(null);
              setCollapsedIds(EMPTY_IDS);
            }}
          />
        </View>
      ) : null}
      <View
        className={
          Platform.OS === "android"
            ? "flex-1 overflow-hidden rounded-t-[28px] bg-sheet-solid"
            : "flex-1"
        }
        collapsable={false}
        style={{ marginHorizontal: Platform.OS === "android" && layout.usesSplitView ? 4 : 0 }}
      >
        {loadingDiff || result.error ? (
          <View style={{ paddingTop: Platform.OS === "ios" && !staleDiff ? insets.top : 0 }}>
            <PullRequestReadStatus pending={loadingDiff} error={result.error} />
          </View>
        ) : null}
        {NativeDiffView && data.rows.length && !seekingFile ? (
          <View className="flex-1" collapsable={false}>
            <NativeDiffView
              initialRowIndex={focusIndex >= 0 ? Math.max(0, focusIndex - 3) : undefined}
              nativeViewRef={nativeView}
              refreshing={result.refreshing}
              onPullToRefresh={result.onPullRefresh}
              style={StyleSheet.absoluteFill}
              rowsJson={bridge.rowsJson}
              themeJson={bridge.themeJson}
              styleJson={bridge.styleJson}
              tokensPatchJson={bridge.tokensPatchJson}
              tokensResetKey={bridge.tokensResetKey}
              collapsedFileIdsJson={bridge.collapsedFileIdsJson}
              onDebug={onDebug}
              viewedFileIdsJson={bridge.viewedFileIdsJson}
              selectedRowIdsJson={bridge.selectedRowIdsJson}
              onPressLine={(event) => {
                const rowId = event.nativeEvent.rowId ?? null;
                setSelectedRowId(rowId);
                if (event.nativeEvent.gesture !== "longPress") commentOnLine(rowId);
              }}
              onToggleViewedFile={(event) => {
                const file = data.files.find((file) => file.id === event.nativeEvent.fileId);
                if (!file || (!commit && !viewed.canToggle)) return;
                const wasViewed = commit
                  ? commitViewedPaths.has(file.path)
                  : viewed.isViewed(file.path);
                setCollapsedIds((ids) =>
                  wasViewed
                    ? ids.filter((id) => id !== file.id)
                    : ids.includes(file.id)
                      ? ids
                      : [...ids, file.id],
                );
                if (commit)
                  setCommitViewedPaths((current) => {
                    const next = new Set(current);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  });
                else void viewed.toggle(file.path);
              }}
              onToggleComment={(event) => {
                const id = event.nativeEvent.commentId;
                if (id?.startsWith("discussion:"))
                  navigation.navigate("PullRequestDiscussion", {
                    ...route.params,
                    discussionId: id.slice("discussion:".length),
                  });
                if (id?.startsWith("draft:")) {
                  const draft = reviewDraft.draft.comments.find(
                    (draft) => draft.id === id.slice("draft:".length),
                  );
                  if (draft)
                    navigation.navigate("PullRequestInlineComment", {
                      ...route.params,
                      ...draft,
                      draftId: draft.id,
                    });
                }
              }}
              onToggleFile={onToggleFile}
              onVisibleFileChange={(event) => setVisibleFileId(event.nativeEvent.fileId ?? null)}
              appearanceScheme={themeAppearance}
              rowHeight={nativeReviewDiffStyle.rowHeight}
              contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
              contentInsetTop={Platform.OS === "ios" ? (staleDiff ? 0 : insets.top) : undefined}
              contentInsetBottom={Platform.OS === "android" ? toolbarHeight : insets.bottom}
              contentResetKey={`pull-request:${route.params.environmentId}:${route.params.repository}:${route.params.number}:${commit ?? "all"}`}
            />
          </View>
        ) : filter.hiddenCount > 0 &&
          !data.rows.length &&
          !result.isPending &&
          !result.error &&
          !seekingFile ? (
          <View style={{ paddingTop: Platform.OS === "ios" ? insets.top : 0 }}>
            <EmptyState
              title="Only test files changed"
              detail="Test files are hidden from this review."
              action={<Button label="Show test files" tone="contrast" onPress={filter.showAll} />}
              variant="plain"
            />
          </View>
        ) : !result.isPending && !result.error && !seekingFile ? (
          <EmptyState
            title="Diff unavailable"
            detail="Open this pull request on its provider to view the changes."
            variant="plain"
          />
        ) : null}
        {result.nextCursor && result.isPending && data.rows.length && !seekingFile ? (
          <View className="flex-row items-center justify-center gap-2 py-2">
            <ActivityIndicator size="small" />
            <Text className="text-xs text-foreground-muted">Loading more files…</Text>
          </View>
        ) : null}
        {result.error && result.nextCursor ? (
          <Pressable
            accessibilityRole="button"
            onPress={result.refresh}
            className="min-h-11 items-center justify-center py-2"
          >
            <Text className="text-sm font-t3-medium">Retry loading remaining files</Text>
          </Pressable>
        ) : null}
        {parsed.kind === "files" && parsed.notice ? (
          <Text className="px-4 py-2 text-2xs text-foreground-muted">{parsed.notice}</Text>
        ) : null}
      </View>
      <PullRequestActionToolbar
        pr={detail.data}
        params={route.params}
        filePath={visibleFile?.path}
        onOpenFiles={() => navigation.navigate("PullRequestFiles", route.params)}
        onHeightChange={setToolbarHeight}
      />
    </View>
  );
}
