import { Toolbar } from "../../components/ui/Toolbar";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { Chip } from "../../components/ui/Chip";
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
  pullRequestActionLabel,
} from "./pullRequestActions";
import * as Clipboard from "expo-clipboard";
import { Menu } from "../../components/ui/Menu";
import { IconButton } from "../../components/ui/IconButton";
import { Button } from "../../components/ui/Button";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { usePullRequestAction } from "./usePullRequestAction";
import { annotatePullRequestDiff, reviewPosition } from "./pullRequestDiffComments";
import { usePullRequestFileFilter } from "./usePullRequestFileFilter";
import {
  handlePullRequestDiffDebugEvent,
  pullRequestDiffInitialPosition,
} from "./pullRequestDiffDebug";
import { usePullRequestDiffHighlightFiles } from "./usePullRequestDiffHighlightFiles";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";
import { type PullRequestDetail, type PullRequestListEntry } from "@t3tools/contracts";
import { PullRequestOverviewLoading } from "./PullRequestOverviewLoading";
import { copyPullRequestLink, sharePullRequestLink } from "./pullRequestLink";
import { pullRequestStatus } from "./pullRequestStatus";
import { use, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
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

import { AppText as Text } from "../../components/ui/AppText";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceSidebarButton } from "../layout/workspace-sidebar-toolbar";
import { useWorkspaceSidebarHeaderItem } from "../layout/useWorkspaceSidebarHeaderItem";
import { useAndroidWorkspaceBack } from "../workspace/useAndroidWorkspaceNavigation";
import { EmptyState } from "../../components/ui/EmptyState";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RelativeTime } from "../../components/RelativeTime";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { usePullRequestLiveChecks } from "./usePullRequestLiveChecks";
import { pullRequestLabelColor } from "./pullRequestList";
import { PullRequestReactions } from "./PullRequestReactions";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { SourceControlAppAccessNotice } from "./SourceControlAppAccessNotice";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import {
  resolveNativeReviewDiffView,
  type NativeReviewDiffViewHandle,
  type NativeReviewDiffViewProps,
} from "../diffs/nativeReviewDiffSurface";
import {
  getCachedNativeReviewDiffData,
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
  usePullRequestDiffEntry,
  type PullRequestDiffParams,
  type PullRequestParams,
} from "./usePullRequestDiff";
import {
  PullRequestAvatar,
  PullRequestDiffStats,
  PullRequestReadStatus,
} from "./PullRequestPresentation";
import { usePullRequestFilesSection } from "./PullRequestFiles";
import { usePullRequestMaintainerEdits } from "./usePullRequestMaintainerEdits";
import { PullRequestDescription } from "./PullRequestDescription";
import { PullRequestMediaVisibleContext } from "./PullRequestMedia";
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
import { pullRequestFileJumpScope, subscribePullRequestFileJump } from "./pullRequestFileJump";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { PullRequestIdentity, PullRequestOverview, PullRequestTabScrollView, usePullRequestActivityRows, usePullRequestToolbarHeight } from "./PullRequestRouteScreen";

export function PullRequestRouteScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const returnToList = useAndroidWorkspaceBack("pullRequests");
  const { layout } = useAdaptiveWorkspaceLayout();
  const sidebarHeaderItem = useWorkspaceSidebarHeaderItem();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [toolbarHeight, setToolbarHeight] = usePullRequestToolbarHeight(insets.bottom);
  // Only iOS lists run under the bars; Android lists start below the header.
  const barInsets = Platform.OS === "ios" ? insets : { top: 0, bottom: 0 };
  const params = route.params;
  usePullRequestEnvironmentFallback(params);
  const connected = usePullRequestConnected(params.environmentId);
  const [chosenSection, setSection] = useState<"overview" | "activity" | "guide">("overview");
  const requestedSection = useRef(chosenSection);
  const [listAnimationsReady, setListAnimationsReady] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const filesContent = usePullRequestFilesSection(params);
  const guidesEnabled = useReviewGuidesEnabled(params);
  // The guide tab goes away while guides are off and overview stands in. The pick is kept, so
  // guides coming back (a settings reload, a reconnect) return to the guide the user chose.
  const shown = (tab: typeof chosenSection) =>
    !guidesEnabled && tab === "guide" ? "overview" : tab;
  const section = shown(chosenSection);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(DEFAULT_ACTIVITY_FILTER);
  const activityContent = usePullRequestActivityRows(params, activityFilter);
  const scrollOffsets = useRef<Record<string, number>>({});
  // The offset of the tab last shown, and which tab that was: a tab standing in for a hidden guide
  // has its own offset, which only its next scroll would record here.
  const currentScrollOffset = useRef<{ tab: typeof section; offset: number }>({
    tab: "overview",
    offset: -barInsets.top,
  });
  const bodyY = useRef(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollViews = useRef<Partial<Record<typeof section, LegendListRef | null>>>({});
  // AnimatedLegendList re-attaches its handle and sets state whenever its ref changes,
  // so an inline ref in the tab map loops the screen into "Maximum update depth exceeded".
  const [listRefs] = useState(() => {
    const listRef = (tab: typeof section) => (list: LegendListRef | null) => {
      scrollViews.current[tab] = list;
    };
    return {
      overview: listRef("overview"),
      guide: listRef("guide"),
      activity: listRef("activity"),
    };
  });
  const selectSection = (next: typeof section) => {
    if (next === section) return;
    const from = shown(requestedSection.current);
    const current =
      currentScrollOffset.current.tab === from
        ? currentScrollOffset.current.offset
        : (scrollOffsets.current[from] ?? -barInsets.top);
    scrollOffsets.current[section] = current;
    const headerEnd = Math.max(-barInsets.top, bodyY.current - barInsets.top);
    const offset = pullRequestTabOffset(current, scrollOffsets.current[next], headerEnd);
    requestedSection.current = next;
    scrollOffsets.current[next] = offset;
    currentScrollOffset.current = { tab: next, offset };
    // LegendList clamps to its measured rows, which leave out the short-tab minHeight below.
    scrollViews.current[next]?.getNativeScrollRef().scrollTo({ y: offset, animated: false });
    setSection(next);
  };
  const tabContent = activityContent;
  const filesY = useRef(0);
  const descriptionY = useRef(0);
  const pendingDescriptionJump = useRef(false);
  const pendingFilesJump = useRef(false);
  const detailAtom = composerPullRequests.detail(requestTarget(params));
  const result = useEnvironmentQuery(detailAtom);
  const pullRefresh = usePullToRefresh(detailAtom);
  const { refresh: refreshDetail } = result;
  useFocusEffect(refreshDetail);
  const pr = usePullRequestLiveChecks(params, result.data);
  const summary = params.initialSummary;
  const identity = pr ?? summary;
  const terminology = sourceControlClients.get(identity?.provider).changeRequest;
  const permissions = usePullRequestPermissions(params, pr);
  const action = usePullRequestAction(params, pr);
  const maintainerEdits = usePullRequestMaintainerEdits(
    params,
    pr,
    permissions.canEditMaintainerEdits,
  );
  const showsDeleteBranch = pr !== null && canPerformPullRequestAction(pr, "delete-branch");
  const stateAction = action.available("close")
    ? "close"
    : action.available("reopen")
      ? "reopen"
      : null;
  const runStateAction = () =>
    stateAction === "close" ? action.confirmClose() : void action.perform("reopen");
  const confirmDeleteBranch = () =>
    pr &&
    action.confirm(
      "delete-branch",
      pullRequestActionLabel("delete-branch", terminology),
      `Delete ${pr.headBranch} from ${pr.headRepositoryNameWithOwner ?? pr.repository}? Local branches and worktrees are not changed.`,
    );
  const stack = usePullRequestStack(params, pr);
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(requestTarget(params)));
  const refreshGuide = useAtomRefresh(composerPullRequests.reviewGuide(requestTarget(params)));
  const registry = use(RegistryContext);
  const refresh = () =>
    pullRefresh.onRefresh(async (signal) => {
      const target = requestTarget(params);
      await composerPullRequests.invalidate
        .run(registry, {
          environmentId: target.environmentId,
          input: { reference: target.input },
        })
        .catch(() => undefined);
      if (signal.aborted) return;
      if (guidesEnabled) refreshGuide();
      stack.refresh();
      refreshActivity();
      filesContent.refresh();
    });
  const jumpToFiles = () => {
    scrollViews.current.overview?.scrollToOffset({
      offset: bodyY.current + filesY.current - barInsets.top,
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
    <PullRequestMarkdownRepository params={params} changeRequest={pr}>
      <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
        <NativeStackScreenOptions
          options={{
            title: `#${params.number}`,
            headerTitle: `#${params.number}`,
            unstable_headerSubtitle: connected
              ? params.repository
              : `${params.repository} · Offline`,
            unstable_headerLeftItems: layout.usesSplitView ? () => [sidebarHeaderItem] : undefined,
          }}
          optionsVersion={[layout.usesSplitView, sidebarHeaderItem]}
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
              ...(permissions.canEditChangeRequest
                ? [
                    {
                      accessibilityLabel: "Edit title",
                      icon: "pencil" as const,
                      overflowOnly: true,
                      onPress: () =>
                        navigation.navigate("PullRequestEdit", { ...params, field: "title" }),
                    },
                    {
                      accessibilityLabel: "Edit description",
                      icon: "doc.text" as const,
                      overflowOnly: true,
                      onPress: () =>
                        navigation.navigate("PullRequestEdit", { ...params, field: "body" }),
                    },
                  ]
                : []),
              ...(maintainerEdits.visible
                ? [
                    {
                      accessibilityLabel: "Allow edits from maintainers",
                      icon: "pencil" as const,
                      selected: maintainerEdits.value,
                      disabled: maintainerEdits.saving,
                      subtitle: maintainerEdits.subtitle,
                      overflowOnly: true,
                      onPress: maintainerEdits.toggle,
                    },
                  ]
                : []),
              ...(identity
                ? [
                    {
                      accessibilityLabel: openOnProviderLabel(identity.provider),
                      icon: "arrow.up.right" as const,
                      onPress: () => void Linking.openURL(identity.url),
                    },
                    {
                      accessibilityLabel: "Copy link",
                      icon: "link" as const,
                      overflowOnly: true,
                      onPress: () => copyPullRequestLink(identity),
                    },
                    {
                      accessibilityLabel: "Share…",
                      icon: "square.and.arrow.up" as const,
                      overflowOnly: true,
                      onPress: () => sharePullRequestLink(identity),
                    },
                  ]
                : []),
              ...(stateAction
                ? [
                    {
                      accessibilityLabel: pullRequestActionLabel(stateAction, terminology),
                      icon: PR_ACTION_ICONS[stateAction],
                      destructive: stateAction === "close",
                      overflowOnly: true,
                      onPress: runStateAction,
                    },
                  ]
                : []),
              ...(showsDeleteBranch
                ? [
                    {
                      accessibilityLabel: pullRequestActionLabel("delete-branch", terminology),
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
        <Toolbar placement="right">
          <Toolbar.Menu
            title={capitalizeTerm(terminology.singular)}
            accessibilityLabel={`${capitalizeTerm(terminology.singular)} actions`}
            icon="ellipsis"
          >
            {permissions.verdicts.length ? (
              <Toolbar.MenuAction
                icon="text.bubble"
                onPress={() =>
                  navigation.navigate("PullRequestReview", { ...params, mode: "review" })
                }
              >
                <Toolbar.Label>Submit review</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {permissions.canComment ? (
              <Toolbar.MenuAction
                icon="plus.bubble"
                onPress={() =>
                  navigation.navigate("PullRequestReview", { ...params, mode: "comment" })
                }
              >
                <Toolbar.Label>Add comment</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {permissions.canEditChangeRequest ? (
              <Toolbar.MenuAction
                icon="pencil"
                onPress={() =>
                  navigation.navigate("PullRequestEdit", { ...params, field: "title" })
                }
              >
                <Toolbar.Label>Edit title</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {permissions.canEditChangeRequest ? (
              <Toolbar.MenuAction
                icon="doc.text"
                onPress={() => navigation.navigate("PullRequestEdit", { ...params, field: "body" })}
              >
                <Toolbar.Label>Edit description</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {maintainerEdits.visible ? (
              <Toolbar.MenuAction
                icon="pencil"
                isOn={maintainerEdits.value}
                disabled={maintainerEdits.saving}
                subtitle={maintainerEdits.subtitle}
                onPress={maintainerEdits.toggle}
              >
                <Toolbar.Label>Allow edits from maintainers</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {identity ? (
              <Toolbar.MenuAction
                icon="arrow.up.right"
                onPress={() => void Linking.openURL(identity.url)}
              >
                <Toolbar.Label>{openOnProviderLabel(identity.provider)}</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {identity ? (
              <Toolbar.MenuAction icon="link" onPress={() => copyPullRequestLink(identity)}>
                <Toolbar.Label>Copy link</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {identity ? (
              <Toolbar.MenuAction
                icon="square.and.arrow.up"
                onPress={() => sharePullRequestLink(identity)}
              >
                <Toolbar.Label>Share…</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {stateAction ? (
              <Toolbar.MenuAction
                icon={PR_ACTION_ICONS[stateAction]}
                destructive={stateAction === "close"}
                onPress={runStateAction}
              >
                <Toolbar.Label>{pullRequestActionLabel(stateAction, terminology)}</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {showsDeleteBranch ? (
              <Toolbar.MenuAction
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
                <Toolbar.Label>
                  {pullRequestActionLabel("delete-branch", terminology)}
                </Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
          </Toolbar.Menu>
        </Toolbar>
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
                  ref={listRefs[tab]}
                  // The scroll view owns its resting offset. LegendList keeps the first
                  // initialScrollOffset it gets, and the first render has the window's top
                  // inset (0 on the folded iPhone Duo), not the header's.
                  onScroll={(event) => {
                    const offset = event.nativeEvent.contentOffset.y;
                    scrollOffsets.current[tab] = offset;
                    if (shown(requestedSection.current) === tab)
                      currentScrollOffset.current = { tab, offset };
                  }}
                  className="flex-1"
                  renderScrollComponent={
                    Platform.OS === "ios" ? PullRequestTabScrollView : undefined
                  }
                  // UIKit owns the bar's inset, so a minimizing bar and a resized column
                  // move the list in the same frame as the bar.
                  contentInsetAdjustmentBehavior="automatic"
                  contentInsetStartAdjustment={barInsets.top}
                  // RN scrollTo clamps against raw insets and ignores the automatic bar inset.
                  scrollToOverflowEnabled
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
                      offset: bodyY.current + descriptionY.current - barInsets.top,
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
                      viewportHeight + headerHeight - barInsets.top - barInsets.bottom,
                    ),
                  }}
                  data={[
                    {
                      key: `${tab}:body`,
                      content: (
                        <View>
                          {tab === "overview" && identity ? (
                            <View>
                              <SourceControlAppAccessNotice
                                environmentId={params.environmentId}
                                provider={identity.provider}
                                host={params.host}
                                repository={params.repository}
                              />
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
                                      if (shown(requestedSection.current) === "overview")
                                        jumpToFiles();
                                    });
                                  }
                                }}
                              >
                                {filesContent.header}
                              </View>
                            </View>
                          ) : null}
                          {tab === "guide" ? (
                            <PullRequestGuideContent
                              params={params}
                              visible={section === "guide"}
                            />
                          ) : null}
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
                              terminology={terminology}
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
                  // Animating overview fights clipped markdown and collapse scroll correction; file rows can still fade.
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
                      <PullRequestMediaVisibleContext value={section === tab}>
                        {item.content}
                      </PullRequestMediaVisibleContext>
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
                        terminology={terminology}
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
                          {/* UIKit draws the tapped control's glass lens outside the hidden
                              tab's opacity, so only the visible tab mounts the control. */}
                          {Platform.OS !== "ios" || section === tab ? (
                            <SegmentedControl
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
                          ) : (
                            <View style={{ height: 32 }} />
                          )}
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

