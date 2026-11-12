import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AppBar as AndroidScreenHeader } from "../../components/ui/AppBar";
import { Menu } from "../../components/ui/Menu";
import { IconButton } from "../../components/ui/IconButton";
import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  pullRequestDiffPathMatches,
  pullRequestLinkCommit,
  resolvePullRequestReviewAnchor,
} from "@t3tools/shared/pullRequestAnchor";
import { isNativeReviewDiffDrawEvent } from "../diffs/nativeReviewDiffSurface";
import { pullRequestFileChapters } from "./pullRequestFileChapters";
import { Chip } from "../../components/ui/Chip";
import { Toolbar } from "../../components/ui/Toolbar";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { readPullRequestView, rememberPullRequestView } from "./pullRequestViewMemory";
import { PullRequestFilesSheet } from "./PullRequestFilesSheet";
import { ReviewDisplayOptions } from "../review/ReviewDisplayOptions";
import { useDiffWhitespacePreference } from "../review/useDiffWhitespacePreference";
import { PullRequestCommentsSheet } from "./PullRequestCommentsSheet";
import { PullRequestCommitPicker } from "./PullRequestCommitPicker";
import { ReviewChapterNavigation } from "../review/ReviewChapterNavigation";
import { reviewFileGroup, type ReviewFileGroup } from "@t3tools/shared/reviewFileClassification";
import { reviewCommentRange, reviewPositionLabel } from "@t3tools/client-runtime/review-selection";
import {
  orderReviewFiles,
  isReviewFileVisible,
  reviewCommentCounts,
  latestReviewedCommit,
  reviewCommitSelection,
} from "@t3tools/client-runtime/review-workspace";
import { pullRequestTabOffset } from "./pullRequestTabScroll";
import { guideFocusedRows, type GuideDiffFocus } from "./guide/guideDiffFocus";
import { PullRequestGuideContent } from "./guide/PullRequestGuideScreen";
import { useReviewGuidesEnabled } from "./guide/useReviewGuide";
import {
  filterPullRequestActivity,
  DEFAULT_ACTIVITY_FILTER,
  type ActivityFilter,
} from "@t3tools/client-runtime/review-activity";
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
import { Button } from "../../components/ui/Button";
import { usePullRequestReviewDraft } from "./usePullRequestReviewDraft";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { usePullRequestDescription } from "./usePullRequestDescription";
import { usePullRequestAction } from "./usePullRequestAction";
import { annotatePullRequestDiff, reviewPosition } from "./pullRequestDiffComments";
import { usePullRequestFileFilter } from "./usePullRequestFileFilter";
import { pullRequestDiffInitialPosition } from "./pullRequestDiffDebug";
import { usePullRequestDiffHighlightFiles } from "./usePullRequestDiffHighlightFiles";
import { usePullRequestViewingPreferences } from "./usePullRequestViewingPreferences";
import { isPullRequestTestFile } from "./pullRequestFileFilters";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";
import {
  pullRequestConversationThreads,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { PullRequestOverviewLoading } from "./PullRequestOverviewLoading";
import { PullRequestComposerNotice } from "./PullRequestComposerNotice";
import { copyPullRequestLink, sharePullRequestLink } from "./pullRequestLink";
import { pullRequestStatus } from "./pullRequestStatus";
import {
  use,
  useEffectEvent,
  useCallback,
  useMemo,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { AppBar } from "../../components/ui/AppBar";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAndroidWorkspaceBack } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { EmptyState } from "../../components/ui/EmptyState";
import { Tabs } from "../../components/ui/Tabs";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { RelativeTime } from "../../components/RelativeTime";
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
import {
  PullRequestActionToolbar,
  PullRequestCardGroup,
  PullRequestHeaderToolbar,
} from "./PullRequestControls";
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

const EMPTY_IDS: readonly string[] = [];

function usePullRequestActivityRows(params: PullRequestParams, filter: ActivityFilter) {
  const navigation = useNavigation();
  const result = useEnvironmentQuery(composerPullRequests.activity(requestTarget(params)));
  const filtered = result.data ? filterPullRequestActivity(result.data, filter) : null;
  const rows = (() => {
    if (!filtered) return [];
    const rows = pullRequestTimelineRows(filtered.activity, params, navigation, filter.newestFirst);
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
  })();
  const location = parsePullRequestAnchor(params.navigationUrl);
  const anchor =
    location?.kind !== "timeline"
      ? null
      : result.data
        ? resolvePullRequestReviewAnchor(
            location.anchor,
            result.data.comments,
            result.data.reviewThreads,
          )
        : location.anchor;
  const targetComment = anchor
    ? result.data?.comments.find((comment) => pullRequestAnchorMatchesUrl(anchor, comment.url))
    : null;
  const targetThread = anchor
    ? result.data &&
      pullRequestConversationThreads(result.data).find((thread) =>
        thread.comments.some((comment) => pullRequestAnchorMatchesUrl(anchor, comment.url)),
      )
    : null;
  const targetKey = targetThread
    ? `discussion:${targetThread.id}`
    : targetComment
      ? `comment:${targetComment.id}`
      : null;
  return {
    rows,
    targetKey,
    targetThread,
    hiddenCount: filtered?.hiddenCount ?? 0,
    pending: result.isPending && !result.data,
    error: result.error,
  };
}

function PullRequestIdentity(props: {
  readonly pr: PullRequestDetail | PullRequestListEntry | PullRequestSummary;
  readonly params: PullRequestParams;
}) {
  const { pr } = props;
  const status = pullRequestStatus({ state: pr.state, isDraft: pr.isDraft === true });
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
        <PullRequestDiffStats additions={pr.additions ?? 0} deletions={pr.deletions ?? 0} compact />
        {"changedFiles" in pr && pr.changedFiles !== undefined ? (
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
        <PullRequestAvatar actor={pr.author ?? null} size={20} />
        <Text className="min-w-0 flex-1 text-xs font-t3-medium" numberOfLines={1}>
          {pr.author?.login ?? "Unknown author"}
        </Text>
        <Text className="shrink text-right text-2xs text-foreground-muted" numberOfLines={1}>
          Updated <RelativeTime timestamp={pr.updatedAt} /> ago
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

function PullRequestLabels(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
}) {
  const navigation = useNavigation();
  const connected = usePullRequestConnected(props.params.environmentId);
  const canWrite = useAtomValue(
    composerPullRequests.setLabels.permissionAtom(requestTarget(props.params).environmentId),
  );
  const editable =
    connected &&
    canWrite &&
    props.pr.capabilities.labels === true &&
    props.pr.viewerPermissions.labels !== false;
  if (!props.pr.labels.length && !editable) return null;
  return (
    <Animated.View layout={PR_ROW_LAYOUT} className="flex-row flex-wrap gap-2">
      {props.pr.labels.map((label) => {
        const color = pullRequestLabelColor(label.color);
        // Tinted like the list row's label pills, at the overview's chip size.
        return (
          <View
            key={label.name}
            className="max-w-full flex-row items-center gap-1.5 rounded-2xl bg-grouped-card px-3 py-1"
            style={color ? { backgroundColor: `${color}20` } : undefined}
          >
            {color ? (
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
            ) : null}
            <Text textRole="caption" className="shrink text-foreground-muted" numberOfLines={1}>
              {label.name}
            </Text>
          </View>
        );
      })}
      {editable ? (
        <Chip
          label={props.pr.labels.length ? "Edit" : "Add labels"}
          icon="tag"
          size="small"
          accessibilityLabel="Edit labels"
          onPress={() => navigation.navigate("PullRequestLabels", props.params)}
        />
      ) : null}
    </Animated.View>
  );
}

function PullRequestOverview(props: {
  readonly pr: PullRequestDetail;
  readonly description: ReturnType<typeof usePullRequestDescription>;
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
      <PullRequestLabels pr={pr} params={props.params} />
      <Animated.View
        layout={PR_POSITION_LAYOUT}
        onLayout={(event) => props.onDescriptionLayout(event.nativeEvent.layout.y)}
      >
        <PullRequestDescription
          markdown={props.description.body}
          onTaskListChange={props.description.toggleTask}
          onCollapse={props.onDescriptionCollapse}
          expanded={props.descriptionExpanded}
          onExpandedChange={props.onDescriptionExpandedChange}
          footer={<PullRequestReactions params={props.params} />}
        />
      </Animated.View>
    </View>
  );
}

function usePullRequestToolbarHeight(bottomInset: number) {
  const { buttonSize } = useAndroidControlSizing();
  return useState(() => (Platform.OS === "android" ? bottomInset + buttonSize + 40 : 0));
}

export function PullRequestRouteScreen(props: StaticScreenProps<PullRequestParams>) {
  return <PullRequestRouteContent key={pullRequestReviewKey(props.route.params)} {...props} />;
}

function PullRequestRouteContent({ route }: StaticScreenProps<PullRequestParams>) {
  const returnToList = useAndroidWorkspaceBack("pullRequests");
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [toolbarHeight, setToolbarHeight] = usePullRequestToolbarHeight(insets.bottom);
  const contentTopInset = useContentTopInset();
  // Only iOS lists run under the bottom safe area; Android's floating toolbar pads its own.
  const contentBottomInset = Platform.OS === "ios" ? insets.bottom : 0;
  const params = route.params;
  usePullRequestEnvironmentFallback(params);
  const connected = usePullRequestConnected(params.environmentId);
  const guidesEnabled = useReviewGuidesEnabled(params);
  const viewMemoryKey = pullRequestReviewKey(params);
  const [chosenSection, setSection] = useState<"overview" | "diff" | "guide" | "activity">(() => {
    const kind = parsePullRequestAnchor(params.navigationUrl)?.kind;
    return kind === "timeline" || kind === "commits"
      ? "activity"
      : (readPullRequestView(viewMemoryKey).section ?? "overview");
  });
  const shown = (tab: typeof chosenSection) =>
    !guidesEnabled && tab === "guide" ? "overview" : tab;
  const section = shown(chosenSection);
  const [visitedSections, setVisitedSections] = useState<ReadonlySet<string>>(
    () => new Set([section]),
  );
  // Keep each tab's native list and measured rows alive when it is hidden.
  const requestedSection = useRef(chosenSection);
  const [listAnimationsReady, setListAnimationsReady] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const filesContent = usePullRequestFilesSection(params);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(() => {
    const kind = parsePullRequestAnchor(params.navigationUrl)?.kind;
    return kind === "timeline"
      ? { ...DEFAULT_ACTIVITY_FILTER, bots: true, resolved: true }
      : kind === "commits"
        ? { ...DEFAULT_ACTIVITY_FILTER, kind: "commits" }
        : DEFAULT_ACTIVITY_FILTER;
  });
  const [commentsOpen, setCommentsOpen] = useState(false);
  const activityContent = usePullRequestActivityRows(params, activityFilter);
  const scrollOffsets = useRef<Record<string, number>>({});
  // The offset of the tab last shown, and which tab that was: a tab standing in for a hidden guide
  // has its own offset, which only its next scroll would record here.
  const currentScrollOffset = useRef<{ tab: typeof section; offset: number }>({
    tab: "overview",
    offset: -contentTopInset,
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
        : (scrollOffsets.current[from] ?? -contentTopInset);
    scrollOffsets.current[section] = current;
    const headerEnd = Math.max(-contentTopInset, bodyY.current - contentTopInset);
    const offset = pullRequestTabOffset(current, scrollOffsets.current[next], headerEnd);
    requestedSection.current = next;
    scrollOffsets.current[next] = offset;
    currentScrollOffset.current = { tab: next, offset };
    scrollViews.current[next]?.scrollToOffset({ offset, animated: false });
    setVisitedSections((current) => new Set(current).add(next));
    setSection(next);
    if (next !== "activity") rememberPullRequestView(viewMemoryKey, { section: next });
  };
  const followLink = useEffectEvent(() => {
    const target = parsePullRequestAnchor(params.navigationUrl);
    if (target?.kind === "diff" || target?.kind === "code") {
      const commit = pullRequestLinkCommit(params.navigationUrl);
      navigation.navigate("PullRequestFile", {
        ...params,
        path: "",
        ...(commit ? { commit } : {}),
      });
    } else if (target?.kind === "timeline") {
      selectSection("activity");
      setActivityFilter((filter) => ({ ...filter, kind: "all", bots: true, resolved: true }));
    } else if (target?.kind === "commits") {
      selectSection("activity");
      setActivityFilter((filter) => ({ ...filter, kind: "commits" }));
    } else if (target?.kind === "checks") {
      selectSection("overview");
      // Checks head Overview, which a reused screen may have scrolled past.
      scrollViews.current.overview?.scrollToOffset({ offset: -contentTopInset, animated: false });
    } else if (target?.kind === "summary") {
      selectSection("overview");
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a link selects its native PR section or diff even when the route is reused
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- URL navigation selects the PR section and makes its target visible
    followLink();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each clicked URL is a fresh navigation request
  }, [params.navigationUrl, params.navigationId]);

  const activityTargetIndex = activityContent.rows.findIndex(
    (row) => row.key === activityContent.targetKey,
  );
  const openedDiscussion = useRef<string | null>(null);
  const positionedActivity = useRef<string | null>(null);
  // Rows above the target measure in after the first jump, so it is held until the user scrolls.
  const heldActivityRow = useRef<number | null>(null);
  const positionActivityRow = (index: number) =>
    void scrollViews.current.activity?.scrollToIndex({
      index,
      viewPosition: 0,
      viewOffset: contentTopInset + 12,
      animated: false,
    });
  const revealActivity = useEffectEvent(() => {
    const key = `${params.navigationUrl}:${params.navigationId ?? 0}`;
    if (activityContent.targetThread && openedDiscussion.current !== key) {
      openedDiscussion.current = key;
      navigation.navigate("PullRequestDiscussion", {
        ...params,
        discussionId: activityContent.targetThread.id,
      });
      return;
    }
    // Later filter or refresh changes move the row; they must not pull the user back to it.
    if (activityTargetIndex >= 0 && positionedActivity.current !== key) {
      positionedActivity.current = key;
      // Its top sits under the app bar; centering a long comment pushed its start off screen.
      heldActivityRow.current = activityTargetIndex + 1;
      positionActivityRow(activityTargetIndex + 1);
    }
  });
  const targetThreadId = activityContent.targetThread?.id;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals the requested activity once its asynchronous rows arrive
  useEffect(() => {
    revealActivity();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reruns when activity resolves the URL target, even a thread the filter hides
  }, [params.navigationUrl, params.navigationId, activityTargetIndex, targetThreadId]);
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
  const description = usePullRequestDescription(params, pr, permissions.canEditChangeRequest);
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
    scrollViews.current.overview?.scrollToIndex({
      index: 0,
      viewPosition: 0,
      viewOffset: -filesY.current,
      animated: true,
    });
    pendingFilesJump.current = false;
  };
  const openFiles = () => {
    selectSection("diff");
  };

  return (
    <PullRequestMarkdownRepository params={params} changeRequest={pr}>
      <View className="flex-1 android:bg-header ios:bg-screen">
        <AppBar
          title={`#${params.number}`}
          subtitle={connected ? params.repository : `${params.repository} · Offline`}
          onBack={layout.usesSplitView ? undefined : returnToList}
          menus={[
            {
              title: `${capitalizeTerm(terminology.singular)} actions`,
              icon: "ellipsis",
              items: [
                ...(permissions.verdicts.length
                  ? [
                      {
                        id: "submit-review",
                        title: "Submit review",
                        icon: "text.bubble",
                        onPress: () =>
                          navigation.navigate("PullRequestReview", { ...params, mode: "review" }),
                      },
                    ]
                  : []),
                ...(permissions.canComment
                  ? [
                      {
                        id: "add-comment",
                        title: "Add comment",
                        icon: "plus.bubble",
                        onPress: () =>
                          navigation.navigate("PullRequestReview", { ...params, mode: "comment" }),
                      },
                    ]
                  : []),
                ...(permissions.canEditChangeRequest
                  ? [
                      {
                        id: "edit-title",
                        title: "Edit title",
                        icon: "pencil",
                        onPress: () =>
                          navigation.navigate("PullRequestEdit", { ...params, field: "title" }),
                      },
                      {
                        id: "edit-description",
                        title: "Edit description",
                        icon: "doc.text",
                        disabled: description.pending,
                        subtitle: description.pending ? "Saving…" : undefined,
                        onPress: () =>
                          navigation.navigate("PullRequestEdit", { ...params, field: "body" }),
                      },
                    ]
                  : []),
                ...(maintainerEdits.visible
                  ? [
                      {
                        id: "maintainer-edits",
                        title: "Allow edits from maintainers",
                        icon: "pencil",
                        selected: maintainerEdits.value,
                        disabled: maintainerEdits.saving,
                        subtitle: maintainerEdits.subtitle,
                        onPress: maintainerEdits.toggle,
                      },
                    ]
                  : []),
                ...(identity
                  ? [
                      {
                        id: "open-on-provider",
                        title: openOnProviderLabel(identity.provider),
                        icon: "arrow.up.right",
                        onPress: () => void Linking.openURL(identity.url),
                      },
                      {
                        id: "copy-link",
                        title: "Copy link",
                        icon: "link",
                        onPress: () => copyPullRequestLink(identity),
                      },
                      {
                        id: "share",
                        title: "Share…",
                        icon: "square.and.arrow.up",
                        onPress: () => sharePullRequestLink(identity),
                      },
                    ]
                  : []),
                ...(stateAction
                  ? [
                      {
                        id: "state",
                        title: pullRequestActionLabel(stateAction, terminology),
                        icon: PR_ACTION_ICONS[stateAction],
                        destructive: stateAction === "close",
                        onPress: runStateAction,
                      },
                    ]
                  : []),
                ...(showsDeleteBranch
                  ? [
                      {
                        id: "delete-branch",
                        title: pullRequestActionLabel("delete-branch", terminology),
                        icon: PR_ACTION_ICONS["delete-branch"],
                        destructive: true,
                        disabled: !action.available("delete-branch"),
                        subtitle: action.busy
                          ? "Deleting…"
                          : connected
                            ? pr.headBranch
                            : "Reconnect to delete this branch.",
                        onPress: confirmDeleteBranch,
                      },
                    ]
                  : []),
              ],
            },
          ]}
        />
        <PullRequestCommentsSheet
          params={params}
          visible={commentsOpen}
          onClose={() => setCommentsOpen(false)}
        />
        <View
          className="flex-1"
          onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        >
          {(["overview", "guide", "activity", "diff"] as const)
            .filter((tab) => tab !== "guide" || guidesEnabled)
            .map((tab) => (
              <View
                key={tab}
                style={[StyleSheet.absoluteFill, { opacity: section === tab ? 1 : 0 }]}
                pointerEvents={section === tab ? "auto" : "none"}
                accessibilityElementsHidden={section !== tab}
                importantForAccessibility={section === tab ? "auto" : "no-hide-descendants"}
              >
                <PullRequestMediaVisibleContext value={section === tab}>
                  {tab === "diff" ? (
                    <View
                      className="flex-1"
                      style={{
                        paddingTop: Platform.OS === "ios" ? insets.top : 0,
                        paddingBottom: Platform.OS === "ios" ? insets.bottom : 0,
                      }}
                    >
                      <View className="px-4 py-3">
                        {Platform.OS !== "ios" || section === tab ? (
                          <Tabs
                            options={[
                              { value: "overview", label: "Overview" },
                              ...(guidesEnabled
                                ? [
                                    {
                                      value: "guide" as const,
                                      label: "Guide",
                                    },
                                  ]
                                : []),
                              { value: "diff", label: "Code" },
                            ]}
                            selected={section}
                            onSelect={selectSection}
                            className="-mx-3.5"
                          />
                        ) : (
                          <View style={{ height: 44 }} />
                        )}
                      </View>
                      <PullRequestDiffContent params={{ ...params, path: "" }} embedded />
                    </View>
                  ) : (
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
                      renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
                      // UIKit owns the bar's inset, so a minimizing bar and a resized column
                      // move the list in the same frame as the bar.
                      contentInsetAdjustmentBehavior="automatic"
                      contentInset={{ top: contentTopInset, bottom: contentBottomInset }}
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
                          offset: bodyY.current + descriptionY.current - contentTopInset,
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
                          viewportHeight + headerHeight - contentTopInset - contentBottomInset,
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
                                      description={description}
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
                                          if (requestedSection.current === "overview")
                                            jumpToFiles();
                                        });
                                      }
                                    }}
                                  >
                                    <PullRequestActivityFilters
                                      value={activityFilter}
                                      onChange={setActivityFilter}
                                      hiddenCount={tabContent.hiddenCount}
                                    />
                                    <PullRequestReadStatus
                                      pending={tabContent.pending}
                                      error={tabContent.error}
                                      terminology={terminology}
                                    />
                                  </View>
                                </View>
                              ) : null}
                              {tab === "guide" ? (
                                <PullRequestGuideContent
                                  params={params}
                                  active={section === "guide"}
                                />
                              ) : null}
                            </View>
                          ),
                        },
                        ...(tab === "overview" ? (identity ? tabContent.rows : []) : []).map(
                          (row) => ({
                            ...row,
                            key: `${tab}:${row.key}`,
                            content: row.content,
                          }),
                        ),
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
                            listAnimationsReady && !item.key.endsWith(":body")
                              ? PR_ROW_EXIT
                              : undefined
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
                              {Platform.OS !== "ios" || section === tab ? (
                                <Tabs
                                  options={[
                                    { value: "overview", label: "Overview" },
                                    ...(guidesEnabled
                                      ? [
                                          {
                                            value: "guide" as const,
                                            label: "Guide",
                                          },
                                        ]
                                      : []),
                                    { value: "activity", label: "Activity" },
                                    { value: "diff", label: "Code" },
                                  ]}
                                  selected={section}
                                  onSelect={selectSection}
                                  className="-mx-3.5"
                                />
                              ) : (
                                <View style={{ height: 44 }} />
                              )}
                            </View>
                          ) : null}
                        </>
                      }
                    />
                  )}
                </PullRequestMediaVisibleContext>
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

type PullRequestFileRouteProps = StaticScreenProps<
  PullRequestDiffParams & {
    readonly path: string;
    readonly replacingDraftId?: string;
    readonly focus?: GuideDiffFocus;
  }
>;

export function PullRequestFileRouteScreen(props: PullRequestFileRouteProps) {
  const navigation =
    useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList, "PullRequestFile">>();
  const ready = usePullRequestDiffEntry(navigation);
  if (ready) return <PullRequestFileRouteContent {...props} />;
  const title = props.route.params.commit ? "Commit changes" : "Changes";
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={title} onBack={() => navigation.goBack()} />
      <View className="flex-1 items-center justify-center">
        <AppActivityIndicator accessibilityLabel="Loading changes" />
      </View>
    </View>
  );
}

function PullRequestFileRouteContent({ route }: PullRequestFileRouteProps) {
  return <PullRequestDiffContent params={route.params} />;
}

type PullRequestFileParams = PullRequestDiffParams & {
  readonly path: string;
  readonly fileSelectionId?: string;
  readonly replacingDraftId?: string;
  readonly focus?: GuideDiffFocus;
};

export function PullRequestDiffContent({
  params,
  embedded = false,
  onlyPaths,
}: {
  params: PullRequestFileParams;
  embedded?: boolean;
  onlyPaths?: ReadonlyArray<string>;
}) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  const [toolbarHeight, setToolbarHeight] = usePullRequestToolbarHeight(insets.bottom);
  const [commit, setCommit] = useState<string | null>(params.commit ?? null);
  const { commit: _requestedCommit, ...reviewParams } = params;
  const { ignoreWhitespace, setIgnoreWhitespace } = useDiffWhitespacePreference();
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(params)));
  const terminology = sourceControlClients.get(
    (detail.data ?? params.initialSummary)?.provider,
  ).changeRequest;
  const result = usePullRequestDiff(
    { ...reviewParams, ...(commit ? { commit } : {}) },
    terminology,
    ignoreWhitespace,
  );
  // Other screens open files with the link's params spread in; only the link's own entry follows it.
  const linkAnchor =
    params.path === "" && (params.commit ?? null) === pullRequestLinkCommit(params.navigationUrl)
      ? parsePullRequestAnchor(params.navigationUrl)
      : null;
  const linkPath =
    linkAnchor?.kind === "diff" && result.parsed.kind === "files"
      ? result.parsed.files.find((file) => pullRequestDiffPathMatches(linkAnchor.digest, file.path))
          ?.path
      : undefined;
  const [filesOpen, setFilesOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const filter = usePullRequestFileFilter(result.parsed, params.focus ? params.path : undefined);
  const { refresh: refreshDetail } = detail;
  useFocusEffect(refreshDetail);
  const { loadMore } = result;
  const reviewDraft = usePullRequestReviewDraft(params);
  const viewed = usePullRequestFilesViewed(params, detail.data);
  const permissions = usePullRequestPermissions(params, detail.data);
  const scopeKey = pullRequestReviewKey(params);
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
  const activity = useEnvironmentQuery(composerPullRequests.activity(requestTarget(params)));
  const { preferences: viewingPreferences, update: updateViewingPreferences } =
    usePullRequestViewingPreferences();
  const { commentsOnly, hideReviewed, groupByType } = viewingPreferences;
  const isGuideChapter = onlyPaths !== undefined;
  const grouped = groupByType && !isGuideChapter;
  const rememberedPath =
    params.path || (onlyPaths === undefined ? (readPullRequestView(scopeKey).path ?? "") : "");
  const [chapterId, setChapterId] = useState<ReviewFileGroup>(() =>
    reviewFileGroup(rememberedPath),
  );
  const { isViewed } = viewed;
  const visibleParsed = useMemo(() => {
    const original = isGuideChapter ? result.parsed : filter.parsed;
    if (original.kind !== "files") return original;
    const counts = reviewCommentCounts(
      original.files.map((file) => ({ path: file.path, previousPath: file.previousPath })),
      activity.data?.reviewThreads ?? [],
      reviewDraft.comments,
    );
    const files = orderReviewFiles(
      original.files.filter(
        (file) =>
          (onlyPaths === undefined || onlyPaths.includes(file.path)) &&
          (isGuideChapter ||
            isReviewFileVisible(
              { commentsOnly, hideReviewed },
              isViewed(file.path),
              (counts.get(file.path)?.unresolved ?? 0) > 0,
            )),
      ),
      (file) => file.path,
      grouped,
    );
    return {
      ...original,
      files,
      fileCount: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }, [
    filter.parsed,
    result.parsed,
    isGuideChapter,
    activity.data,
    reviewDraft.comments,
    commentsOnly,
    hideReviewed,
    grouped,
    isViewed,
    onlyPaths,
  ]);
  const chapterIndex = useMemo(
    () =>
      pullRequestFileChapters({
        completePaths:
          !detail.data || (viewed.supported && (!viewed.ready || viewed.truncated))
            ? null
            : !commit && viewed.filePaths !== null
              ? viewed.filePaths
              : !result.isPending &&
                  !result.error &&
                  result.nextCursor === null &&
                  result.parsed.kind === "files"
                ? result.parsed.files.map((file) => file.path)
                : null,
        loadedPaths:
          filter.parsed.kind === "files" ? filter.parsed.files.map((file) => file.path) : [],
        visiblePaths:
          visibleParsed.kind === "files" ? visibleParsed.files.map((file) => file.path) : [],
        hideTestFiles: filter.hideTestFiles,
        includePath: params.focus ? params.path : undefined,
      }),
    [
      commit,
      detail.data,
      viewed.supported,
      viewed.ready,
      viewed.truncated,
      viewed.filePaths,
      result.isPending,
      result.error,
      result.nextCursor,
      result.parsed,
      filter.parsed,
      filter.hideTestFiles,
      visibleParsed,
      params.focus,
      params.path,
    ],
  );
  const chapters = grouped ? chapterIndex.chapters : [];
  const activeChapter = chapters.find((chapter) => chapter.id === chapterId) ?? chapters[0];
  const chapterFiles = activeChapter?.files ?? EMPTY_IDS;
  const reviewedChapterFiles = chapterFiles.filter(viewed.isViewed).length;
  const parsed = useMemo(() => {
    if (!activeChapter || visibleParsed.kind !== "files") return visibleParsed;
    const files = visibleParsed.files.filter(
      (file) => reviewFileGroup(file.path) === activeChapter.id,
    );
    return {
      ...visibleParsed,
      files,
      fileCount: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }, [activeChapter, visibleParsed]);
  const baseData = useMemo(() => getCachedNativeReviewDiffData({ parsedDiff: parsed }), [parsed]);
  const highlightFiles = usePullRequestDiffHighlightFiles(params, parsed, baseData.files);
  const data = useMemo(
    () =>
      annotatePullRequestDiff(
        { ...baseData, files: highlightFiles },
        staleDiff || commit ? [] : reviewDraft.threads,
        commit ? [] : reviewDraft.comments,
        diffHead.sha ?? undefined,
      ),
    [
      baseData,
      highlightFiles,
      reviewDraft.threads,
      reviewDraft.comments,
      diffHead.sha,
      staleDiff,
      commit,
    ],
  );
  const viewedIds = data.files.filter((file) => viewed.isViewed(file.path)).map((file) => file.id);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [rangeEndRowId, setRangeEndRowId] = useState<string | null>(null);
  const startIndex = data.rows.findIndex((row) => row.id === selectedRowId);
  const endIndex = data.rows.findIndex((row) => row.id === rangeEndRowId);
  const selectedRows =
    startIndex < 0
      ? []
      : data.rows
          .slice(
            Math.min(startIndex, endIndex < 0 ? startIndex : endIndex),
            Math.max(startIndex, endIndex < 0 ? startIndex : endIndex) + 1,
          )
          .filter((row) => row.kind === "line" && row.fileId === data.rows[startIndex]?.fileId);
  const firstPosition = selectedRows[0] ? reviewPosition(selectedRows[0]) : null;
  const lastRow = selectedRows.at(-1);
  const lastPosition = lastRow ? reviewPosition(lastRow) : null;
  const selectedRange =
    firstPosition && lastPosition ? reviewCommentRange(firstPosition, lastPosition) : null;
  const selectedRow = data.rows.find((row) => row.id === selectedRowId);
  const selectedFile = data.files.find((file) => file.id === selectedRow?.fileId);
  const commentOnLine = (rowId = selectedRowId) => {
    const row = data.rows.find((row) => row.id === rowId);
    const file = data.files.find((file) => file.id === row?.fileId);
    if (!row || !file || !diffHead.sha || !canCommentOnDiff) return;
    const rowPosition = reviewPosition(row);
    const range =
      rowId === selectedRowId ? selectedRange : rowPosition ? { position: rowPosition } : null;
    if (!range) return;
    const oldPath =
      parsed.kind === "files"
        ? parsed.files.find((entry) => entry.id === file.id)?.previousPath
        : null;
    if (params.replacingDraftId) navigation.setParams({ replacingDraftId: undefined });
    navigation.navigate("PullRequestInlineComment", {
      ...params,
      ...(params.replacingDraftId ? { draftId: params.replacingDraftId } : {}),
      path: file.path,
      ...(oldPath ? { oldPath } : {}),
      position: range.position,
      ...(range.startPosition ? { startPosition: range.startPosition } : {}),
      headSha: diffHead.sha,
      code:
        rowId === selectedRowId
          ? selectedRows.map((line) => line.content ?? "").join("\n")
          : (row.content ?? ""),
    });
  };
  const [pickedPath, setJumpPath] = useState<string | null>(null);
  const jumpPath = pickedPath ?? linkPath ?? rememberedPath;
  const requestedFile =
    result.parsed.kind === "files"
      ? result.parsed.files.find((file) => file.path === jumpPath)
      : undefined;
  const targetFile =
    data.files.find((file) => file.path === jumpPath) ??
    (linkAnchor?.kind === "diff" && !linkPath
      ? undefined
      : !jumpPath || requestedFile
        ? data.files[0]
        : undefined);
  const range = pickedPath === null && linkAnchor?.kind === "diff" ? linkAnchor.range : null;
  const focus =
    params.focus ??
    (range
      ? {
          side: range.side === "left" ? ("old" as const) : ("new" as const),
          start: range.start,
          end: range.end,
          endSide: range.endSide === "left" ? ("old" as const) : ("new" as const),
        }
      : undefined);
  const focusedRows = guideFocusedRows(data.rows, targetFile?.id, focus);
  const focusIndex = focusedRows.length
    ? data.rows.findIndex((row) => row.id === focusedRows[0]?.id)
    : -1;
  const [collapsedIds, setCollapsedIds] = useState<readonly string[]>(EMPTY_IDS);
  const [expandedViewed, setExpandedViewed] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleFileId, setVisibleFileId] = useState<string | null>(null);
  const nativeView = useRef<NativeReviewDiffViewHandle>(null);
  // The filter the current jump was made under. Hiding or showing test files replaces the rows,
  // so a jump made under the other filter has to run again. Native applies the entry
  // destination before its first viewport, so the first one counts as made.
  const jumpedUnder = useRef<boolean | null>(targetFile ? filter.hideTestFiles : null);
  const hasTestFiles =
    result.parsed.kind === "files" &&
    result.parsed.files.some((file) => isPullRequestTestFile(file.path));
  const jumpStarted = () =>
    jumpedUnder.current !== null && (!hasTestFiles || jumpedUnder.current === filter.hideTestFiles);
  const activeChapterId = activeChapter?.id;
  const [lastChapter, setLastChapter] = useState(activeChapterId);
  if (lastChapter !== activeChapterId) {
    setLastChapter(activeChapterId);
    if (activeChapter) {
      if (!jumpPath || reviewFileGroup(jumpPath) !== activeChapter.id)
        setJumpPath(activeChapter.files[0] ?? "");
      setSelectedRowId(null);
      setRangeEndRowId(null);
      setCollapsedIds(EMPTY_IDS);
    }
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-arms native file scrolling when a new chapter is mounted
  useLayoutEffect(() => {
    if (activeChapterId !== undefined) jumpedUnder.current = null;
  }, [activeChapterId]);
  const jumpScope = pullRequestFileJumpScope(params);
  const jumpToFile = useEffectEvent((path: string) => {
    if (params.focus) navigation.setParams({ focus: undefined });
    setJumpPath(path);
    setChapterId(reviewFileGroup(path));
    setSelectedRowId(null);
    setRangeEndRowId(null);
    jumpedUnder.current = null;
    const file = data.files.find((entry) => entry.path === path);
    if (!file || !nativeView.current) return;
    setCollapsedIds((ids) => ids.filter((id) => id !== file.id));
    jumpedUnder.current = filter.hideTestFiles;
    void nativeView.current.scrollToFile(file.id, false).catch(() => {
      jumpedUnder.current = null;
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to file-jump events from the native review navigator
  useEffect(() => subscribePullRequestFileJump(jumpScope, (path) => jumpToFile(path)), [jumpScope]);
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance, appearance, setCodeWordBreak } = useAppearancePreferences();
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId: `pull-request:${params.repository}:${params.number}:${commit ?? "all"}:${activeChapter?.id ?? "all"}`,
    diff: result.patch,
    data,
    collapsedFileIds: [
      ...new Set([...collapsedIds, ...viewedIds.filter((id) => !expandedViewed.has(id))]),
    ],
    viewedFileIds: viewedIds,
    selectedRowIds: selectedRows.length
      ? selectedRows.map((row) => row.id)
      : focusedRows.map((row) => row.id),
    canHighlight: true,
  });
  const [NativeDiffView] = useState(() => resolveNativeReviewDiffView());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load the selected file when asynchronously fetched metadata makes it available.
  useEffect(() => {
    const parsed = result.parsed;
    if (
      !targetFile ||
      (onlyPaths !== undefined &&
        parsed.kind === "files" &&
        onlyPaths.some((path) => !parsed.files.some((file) => file.path === path)))
    )
      loadMore();
  }, [targetFile, loadMore, onlyPaths, result.parsed]);
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
        !jumpStarted() &&
        nativeView.current &&
        (Platform.OS !== "ios" || decoded)
      ) {
        jumpedUnder.current = filter.hideTestFiles;
        if (focusIndex >= 0) return;
        void nativeView.current.scrollToFile(targetFile.id, false).catch(() => {
          jumpedUnder.current = null;
        });
        return;
      }
      if (!drawn) return;
      const lastRow = event.nativeEvent.lastRowIndex;
      if (typeof lastRow === "number" && lastRow >= data.rows.length - 40) loadMore();
    },
    [
      updateVisibleRange,
      data.rows.length,
      loadMore,
      targetFile,
      focusIndex,
      jumpStarted,
      filter.hideTestFiles,
    ],
  );
  const onToggleFile = useCallback<NonNullable<NativeReviewDiffViewProps["onToggleFile"]>>(
    (event) => {
      const id = event.nativeEvent.fileId;
      if (!id) return;
      if (viewedIds.includes(id)) {
        setExpandedViewed((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      } else
        setCollapsedIds((ids) =>
          ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
        );
    },
    [viewedIds, setExpandedViewed, setCollapsedIds],
  );
  const visibleFile = data.files.find((file) => file.id === visibleFileId) ?? targetFile;
  const toggleTestFiles = () => {
    setJumpPath(visibleFile?.path ?? params.path);
    setSelectedRowId(null);
    setRangeEndRowId(null);
    filter.toggle();
  };
  const commits =
    [...(activity.data?.commits ?? [])].sort(
      (a, b) => Date.parse(a.committedDate) - Date.parse(b.committedDate),
    ) ?? [];
  const commitOids = commits.map((entry) => entry.oid);
  const selectedCommits = reviewCommitSelection(commitOids, commit);
  const lastReviewed = latestReviewedCommit(activity.data?.comments ?? [], detail.data?.viewer);
  const [commitPickerOpen, setCommitPickerOpen] = useState(false);
  const selectCommitScope = (scope: string | null) => {
    setJumpPath("");
    setSelectedRowId(null);
    setRangeEndRowId(null);
    setCommit(scope);
  };
  const viewingActions = !isGuideChapter
    ? [
        {
          id: "comments-only",
          title: "Files with unresolved comments",
          state: commentsOnly ? ("on" as const) : ("off" as const),
        },
        {
          id: "hide-reviewed",
          title: "Hide reviewed files",
          state: hideReviewed ? ("on" as const) : ("off" as const),
          attributes: { disabled: !viewed.supported },
        },
        {
          id: "group-files",
          title: "Group by file type",
          state: groupByType ? ("on" as const) : ("off" as const),
        },
      ]
    : [];
  const expandAllFiles = () => {
    setCollapsedIds(EMPTY_IDS);
    setExpandedViewed(new Set(viewedIds));
  };
  const collapseAllFiles = () => {
    setCollapsedIds(data.files.map((file) => file.id));
    setExpandedViewed(new Set());
  };
  const changeViewingOption = (id: string) => {
    setJumpPath("");
    setSelectedRowId(null);
    setRangeEndRowId(null);
    if (id === "comments-only") updateViewingPreferences({ commentsOnly: !commentsOnly });
    else if (id === "hide-reviewed" && viewed.supported)
      updateViewingPreferences({ hideReviewed: !hideReviewed });
    else if (id === "group-files") updateViewingPreferences({ groupByType: !groupByType });
  };
  const selectChapter = (position: number) => {
    const chapter = chapters[position];
    if (!chapter) return;
    setChapterId(chapter.id);
    setJumpPath(chapter.files[0] ?? "");
    setSelectedRowId(null);
    setRangeEndRowId(null);
    jumpedUnder.current = null;
    setCollapsedIds(EMPTY_IDS);
  };
  const allCollapsed =
    data.files.length > 0 &&
    data.files.every(
      (file) =>
        collapsedIds.includes(file.id) ||
        (viewedIds.includes(file.id) && !expandedViewed.has(file.id)),
    );
  const toggleAllFiles = allCollapsed ? expandAllFiles : collapseAllFiles;
  const fileCommentCounts = reviewCommentCounts(
    parsed.kind === "files" ? parsed.files : [],
    commit ? [] : reviewDraft.threads,
    commit ? [] : reviewDraft.comments,
  );
  const treeFiles =
    parsed.kind === "files"
      ? parsed.files.map((file) => ({
          path: file.path,
          previousPath: file.previousPath,
          changeType: file.changeType,
          additions: file.additions,
          deletions: file.deletions,
          reviewed: viewed.isViewed(file.path),
          unresolved: fileCommentCounts.get(file.path)?.unresolved ?? 0,
        }))
      : [];
  const chooseTreeFile = (path: string) => {
    setJumpPath(path);
    setSelectedRowId(null);
    setRangeEndRowId(null);
    const file = data.files.find((entry) => entry.path === path);
    if (!file) return;
    setCollapsedIds((ids) => ids.filter((id) => id !== file.id));
    setExpandedViewed((ids) => new Set(ids).add(file.id));
    jumpedUnder.current = null;
    if (nativeView.current) {
      jumpedUnder.current = filter.hideTestFiles;
      void nativeView.current.scrollToFile(file.id, true).catch(() => {
        jumpedUnder.current = null;
      });
    }
  };
  const displayOptions = [
    {
      id: "wrap",
      label: "Wrap lines",
      checked: appearance.codeWordBreak,
      onChange: setCodeWordBreak,
    },
    {
      id: "whitespace",
      label: "Hide whitespace changes",
      checked: ignoreWhitespace,
      onChange: setIgnoreWhitespace,
    },
    {
      id: "tests",
      label: "Hide test files",
      checked: filter.hideTestFiles,
      onChange: () => toggleTestFiles(),
    },
    ...viewingActions.map((action) => ({
      id: action.id,
      label: action.title,
      checked: action.state === "on",
      disabled: "attributes" in action && action.attributes?.disabled === true,
      onChange: () => changeViewingOption(action.id),
    })),
  ];
  const title = commit ? "Commit changes" : "Changes";
  const seekingFile = !targetFile && result.nextCursor !== null;
  const loadingDiff = (result.isPending && !data.rows.length) || (seekingFile && !result.error);
  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      {!embedded ? (
        <NativeStackScreenOptions
          options={{
            title,
            headerTitle: title,
            unstable_headerSubtitle: `${commit ? commit.slice(0, 7) : `#${params.number}`} · ${data.files.length} ${data.files.length === 1 ? "file" : "files"}${filter.hideTestFiles && filter.hiddenCount ? ` · ${filter.hiddenCount} ${filter.hiddenCount === 1 ? "test" : "tests"} hidden` : ""}`,
          }}
        />
      ) : null}
      {!embedded && Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={title}
          onBack={() => navigation.goBack()}
          trailing={
            <Menu
              actions={[
                { id: "view-files", title: "View files", image: "folder" },
                { id: "view-options", title: "View options", image: "slider.horizontal.3" },
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
                if (nativeEvent.event === "view-files") setFilesOpen(true);
                else if (nativeEvent.event === "view-options") setOptionsOpen(true);
                else if (
                  nativeEvent.event === "submit-review" ||
                  nativeEvent.event === "comment-on-pr"
                )
                  navigation.navigate("PullRequestReview", {
                    ...params,
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
      {!embedded ? (
        <>
          <PullRequestCommentsSheet
            params={params}
            visible={commentsOpen}
            onClose={() => setCommentsOpen(false)}
          />
          <PullRequestHeaderToolbar
            pr={detail.data}
            params={params}
            filePath={visibleFile?.path}
            title="Diff options"
            onOpenComments={() => setCommentsOpen(true)}
            commentsInHorizontalBar={false}
            controls={[
              commits.length > 0 ? (
                <Toolbar.Button
                  key="commit-range"
                  label={
                    commit === null
                      ? "All"
                      : `${selectedCommits.length} ${selectedCommits.length === 1 ? "commit" : "commits"}`
                  }
                  accessibilityLabel="Commit range"
                  icon="arrow.triangle.branch"
                  onPress={() => setCommitPickerOpen(true)}
                />
              ) : null,
              !isGuideChapter ? (
                <Toolbar.Custom key="file-expansion">
                  <PullRequestFileExpansionActions
                    collapsed={allCollapsed}
                    onToggle={toggleAllFiles}
                  />
                </Toolbar.Custom>
              ) : null,
            ]}
            railMenuItems={
              <>
                {commits.length > 0 ? (
                  <Toolbar.MenuAction
                    icon="arrow.triangle.branch"
                    onPress={() => setCommitPickerOpen(true)}
                  >
                    <Toolbar.Label>Commit range</Toolbar.Label>
                  </Toolbar.MenuAction>
                ) : null}
                {!isGuideChapter ? (
                  <Toolbar.MenuAction
                    icon={
                      allCollapsed
                        ? "arrow.up.left.and.arrow.down.right"
                        : "arrow.down.right.and.arrow.up.left"
                    }
                    onPress={toggleAllFiles}
                  >
                    <Toolbar.Label>
                      {allCollapsed ? "Expand all files" : "Collapse all files"}
                    </Toolbar.Label>
                  </Toolbar.MenuAction>
                ) : null}
              </>
            }
          >
            <Toolbar.MenuAction icon="folder" onPress={() => setFilesOpen(true)}>
              <Toolbar.Label>View files</Toolbar.Label>
            </Toolbar.MenuAction>
            <Toolbar.MenuAction icon="slider.horizontal.3" onPress={() => setOptionsOpen(true)}>
              <Toolbar.Label>View options</Toolbar.Label>
            </Toolbar.MenuAction>
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
            {selectedRow && selectedFile && canCommentOnDiff ? (
              <Toolbar.MenuAction icon="bubble.left" onPress={() => commentOnLine()}>
                <Toolbar.Label>
                  {params.replacingDraftId ? "Move draft to this line" : "Add review comment"}
                </Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
            {selectedRow && selectedFile ? (
              <Toolbar.MenuAction
                icon="document.on.document"
                onPress={() => void Clipboard.setStringAsync(selectedRow.content ?? "")}
              >
                <Toolbar.Label>Copy line</Toolbar.Label>
              </Toolbar.MenuAction>
            ) : null}
          </PullRequestHeaderToolbar>
        </>
      ) : null}
      {!embedded && !isGuideChapter && Platform.OS === "android" ? (
        <View className="flex-row justify-end px-4">
          <PullRequestFileExpansionActions collapsed={allCollapsed} onToggle={toggleAllFiles} />
        </View>
      ) : null}
      {embedded ? (
        <View className="flex-row items-center justify-end gap-1 px-4 py-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
            {data.files.length} files
          </Text>
          {!isGuideChapter ? (
            <PullRequestFileExpansionActions collapsed={allCollapsed} onToggle={toggleAllFiles} />
          ) : null}
          {!isGuideChapter && commits.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Commit range"
              className="min-h-11 max-w-[45%] flex-row items-center gap-1.5 rounded-lg bg-secondary px-2.5"
              onPress={() => setCommitPickerOpen(true)}
            >
              <Text numberOfLines={1} className="min-w-0 shrink text-xs">
                {commit === null
                  ? "All"
                  : `${selectedCommits.length} ${selectedCommits.length === 1 ? "commit" : "commits"}`}
              </Text>
              <SymbolView name="chevron.down" size={10} tintColorClassName="accent-icon-muted" />
            </Pressable>
          ) : null}
          <Menu
            title="Code options"
            actions={[
              { id: "view-files", title: "View files", image: "folder" },
              { id: "view-options", title: "View options", image: "slider.horizontal.3" },
            ]}
            onPressAction={({ nativeEvent }) =>
              nativeEvent.event === "view-files" ? setFilesOpen(true) : setOptionsOpen(true)
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Code options"
              className="min-h-11 min-w-11 items-center justify-center"
            >
              <SymbolView name="ellipsis" size={20} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </Menu>
        </View>
      ) : null}
      <ReviewDisplayOptions
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        options={displayOptions}
      />
      <PullRequestFilesSheet
        open={filesOpen}
        onClose={() => setFilesOpen(false)}
        title={activeChapter || isGuideChapter ? "Files in this chapter" : "Files"}
        files={treeFiles}
        onSelectFile={chooseTreeFile}
        onSetViewed={viewed.canToggle && !commit && !staleDiff ? viewed.setManyViewed : undefined}
        onLoadMore={result.canLoadMore ? result.loadMore : undefined}
      />
      <PullRequestCommitPicker
        open={commitPickerOpen}
        onClose={() => setCommitPickerOpen(false)}
        commits={commits}
        scope={commit}
        lastReviewed={lastReviewed}
        canSelectRange={detail.data?.provider === "github"}
        onChange={selectCommitScope}
      />
      {activeChapter ? (
        <View className="border-b border-border-subtle px-4">
          <ReviewChapterNavigation
            chapters={chapters}
            position={chapters.indexOf(activeChapter)}
            reviewedCount={reviewedChapterFiles}
            fileCount={chapterIndex.complete ? chapterFiles.length : null}
            onSelect={selectChapter}
            reviewedDisabled={!chapterIndex.complete}
            onToggleReviewed={
              viewed.canToggle && !commit && !staleDiff
                ? () =>
                    viewed.setManyViewed(chapterFiles, reviewedChapterFiles !== chapterFiles.length)
                : undefined
            }
          />
        </View>
      ) : null}
      {params.replacingDraftId ? (
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
          style={{ paddingTop: contentTopInset + 8 }}
        >
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            The branch changed. Reload before adding line comments.
          </Text>
          <Button
            label="Reload changes"
            onPress={() => {
              result.refresh();
              setDiffHead({ scopeKey, sha: detail.data?.headSha ?? null });
              jumpedUnder.current = null;
              setSelectedRowId(null);
              setRangeEndRowId(null);
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
          <View
            style={{
              paddingTop: !embedded && Platform.OS === "ios" && !staleDiff ? insets.top : 0,
            }}
          >
            <PullRequestReadStatus
              pending={loadingDiff}
              error={result.error}
              terminology={terminology}
            />
          </View>
        ) : null}
        {NativeDiffView && data.rows.length && !seekingFile ? (
          <View className="flex-1" collapsable={false}>
            <NativeDiffView
              {...pullRequestDiffInitialPosition(targetFile?.id, focusIndex)}
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
              showViewedCheckbox={viewed.supported}
              viewedCheckboxEnabled={viewed.canToggle}
              selectedRowIdsJson={bridge.selectedRowIdsJson}
              enableLineRangeSelection={detail.data?.capabilities.review.rangeComment === true}
              onPressLine={(event) => {
                const rowId = event.nativeEvent.rowId ?? null;
                const row = data.rows.find((row) => row.id === rowId);
                if (row?.kind !== "line" || !reviewPosition(row)) return;
                setSelectedRowId(rowId);
                setRangeEndRowId(null);
              }}
              onSelectLineRange={({ nativeEvent }) => {
                const first = data.rows.find((row) => row.id === nativeEvent.startRowId);
                const last = data.rows.find((row) => row.id === nativeEvent.endRowId);
                if (
                  !first ||
                  !last ||
                  first.fileId !== last.fileId ||
                  !reviewPosition(first) ||
                  !reviewPosition(last)
                )
                  return;
                setSelectedRowId(first.id);
                setRangeEndRowId(last.id);
              }}
              onToggleViewedFile={(event) => {
                const file = data.files.find((file) => file.id === event.nativeEvent.fileId);
                if (!file || !viewed.canToggle) return;
                const wasViewed = viewed.isViewed(file.path);
                setCollapsedIds((ids) =>
                  wasViewed
                    ? ids.filter((id) => id !== file.id)
                    : ids.includes(file.id)
                      ? ids
                      : [...ids, file.id],
                );
                void viewed.toggle(file.path);
              }}
              onToggleComment={(event) => {
                const id = event.nativeEvent.commentId;
                if (id?.startsWith("discussion:"))
                  navigation.navigate("PullRequestDiscussion", {
                    ...params,
                    discussionId: id.slice("discussion:".length),
                  });
                if (id?.startsWith("draft:")) {
                  const draft = reviewDraft.comments.find(
                    (draft) => draft.id === id.slice("draft:".length),
                  );
                  if (draft)
                    navigation.navigate("PullRequestInlineComment", {
                      ...params,
                      ...draft,
                      draftId: draft.id,
                    });
                }
              }}
              onToggleFile={onToggleFile}
              onVisibleFileChange={(event) => {
                const fileId = event.nativeEvent.fileId ?? null;
                setVisibleFileId(fileId);
                const file = data.files.find((entry) => entry.id === fileId);
                if (file && !isGuideChapter) rememberPullRequestView(scopeKey, { path: file.path });
              }}
              appearanceScheme={themeAppearance}
              rowHeight={nativeReviewDiffStyle.rowHeight}
              contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
              contentInsetTop={
                Platform.OS === "ios" ? (embedded || staleDiff ? 0 : insets.top) : undefined
              }
              contentInsetBottom={Platform.OS === "android" ? toolbarHeight : insets.bottom}
              contentResetKey={`pull-request:${params.environmentId}:${params.repository}:${params.number}:${commit ?? "all"}`}
            />
          </View>
        ) : !isGuideChapter &&
          result.parsed.kind === "files" &&
          result.parsed.files.length > 0 &&
          !data.rows.length &&
          !result.isPending &&
          !result.error &&
          !seekingFile &&
          (commentsOnly || hideReviewed) ? (
          <View style={{ paddingTop: !embedded && Platform.OS === "ios" ? insets.top : 0 }}>
            <EmptyState
              title={commentsOnly ? "No files with unresolved comments" : "No unreviewed files"}
              detail="No files match the current review filters."
              action={
                <Button
                  label="Show all files"
                  tone="contrast"
                  onPress={() =>
                    updateViewingPreferences({ commentsOnly: false, hideReviewed: false })
                  }
                />
              }
              variant="plain"
            />
          </View>
        ) : !isGuideChapter &&
          filter.hiddenCount > 0 &&
          !data.rows.length &&
          !result.isPending &&
          !result.error &&
          !seekingFile ? (
          <View style={{ paddingTop: !embedded && Platform.OS === "ios" ? insets.top : 0 }}>
            <EmptyState
              title="Diff unavailable"
              detail={`Open this ${terminology.singular} on its provider to view the changes.`}
              variant="plain"
            />
          </View>
        ) : !result.isPending && !result.error && !seekingFile ? (
          <EmptyState
            title="Diff unavailable"
            detail={`Open this ${terminology.singular} on its provider to view the changes.`}
            variant="plain"
          />
        ) : null}
        {result.nextCursor && result.isPending && data.rows.length && !seekingFile ? (
          <View className="flex-row items-center justify-center gap-2 py-2">
            <AppActivityIndicator size="small" />
            <Text className="text-xs text-foreground-muted">Loading more files…</Text>
          </View>
        ) : null}
        {result.error && result.nextCursor ? (
          <View className="self-center">
            <Button label="Retry loading remaining files" tone="text" onPress={result.refresh} />
          </View>
        ) : null}
        {parsed.kind === "files" && parsed.notice ? (
          <Text className="px-4 py-2 text-2xs text-foreground-muted">{parsed.notice}</Text>
        ) : null}
      </View>
      {selectedRange ? (
        <View
          pointerEvents="box-none"
          className="absolute right-4 left-4 flex-row items-center justify-end gap-2"
          style={{
            bottom: (Platform.OS === "android" && !embedded ? toolbarHeight : insets.bottom) + 16,
          }}
        >
          {canCommentOnDiff ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Comment on ${reviewPositionLabel(selectedRange.position, selectedRange.startPosition)}`}
              className="min-h-11 max-w-[85%] flex-row items-center gap-2 rounded-xl bg-primary px-4 py-2"
              onPress={() => commentOnLine()}
            >
              <SymbolView
                name="bubble.left"
                size={18}
                tintColorClassName="accent-primary-foreground"
              />
              <Text
                numberOfLines={1}
                className="shrink text-sm font-t3-medium text-primary-foreground"
              >
                Comment · {reviewPositionLabel(selectedRange.position, selectedRange.startPosition)}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear line selection"
            className="min-h-11 min-w-11 items-center justify-center rounded-xl bg-primary"
            onPress={() => {
              setSelectedRowId(null);
              setRangeEndRowId(null);
            }}
          >
            <SymbolView name="xmark" size={16} tintColorClassName="accent-primary-foreground" />
          </Pressable>
        </View>
      ) : null}
      {!embedded ? (
        <PullRequestActionToolbar
          pr={detail.data}
          params={params}
          filePath={visibleFile?.path}
          showFiles={false}
          onHeightChange={setToolbarHeight}
        />
      ) : null}
    </View>
  );
}

function PullRequestFileExpansionActions(props: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.collapsed ? "Expand all files" : "Collapse all files"}
      className="min-h-11 flex-row items-center gap-1.5 px-2"
      onPress={props.onToggle}
    >
      <SymbolView
        name={props.collapsed ? "diff.expand" : "diff.collapse"}
        size={17}
        tintColorClassName="accent-icon-muted"
      />
      <Text className="text-xs text-foreground-muted">
        {props.collapsed ? "Expand all" : "Collapse all"}
      </Text>
    </Pressable>
  );
}
