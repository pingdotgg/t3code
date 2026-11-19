import {
  isFileDiffCollapsed,
  withFileDiffFold,
  type FileDiffFoldChoices,
} from "@t3tools/client-runtime/pull-request-diff-fold";
import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  pullRequestDiffPathMatches,
  pullRequestLinkCommit,
  resolvePullRequestAnchorRange,
  resolvePullRequestReviewAnchor,
} from "@t3tools/shared/pullRequestAnchor";
import { T, useGT, useMessages } from "gt-react-native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { pullRequestTabOffset } from "./pullRequestTabScroll";
import { guideFocusedRows, type GuideDiffFocus } from "./guide/guideDiffFocus";
import { PullRequestGuideContent } from "./guide/PullRequestGuideScreen";
import { useReviewGuidesEnabled } from "./guide/useReviewGuide";
import { filterPullRequestActivity, type ActivityFilter } from "./pullRequestActivityFilter";
import { PullRequestActivityFilters } from "./PullRequestActivityFilters";
import { usePullRequestActivityFilter } from "./usePullRequestActivityFilter";
import type { LegendListRef } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import Animated from "react-native-reanimated";
import { PR_ROW_LAYOUT, PR_ROW_ENTER, PR_ROW_EXIT } from "./pullRequestAnimations";
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
import {
  handlePullRequestDiffDebugEvent,
  pullRequestDiffInitialPosition,
} from "./pullRequestDiffDebug";
import { usePullRequestDiffHighlightFiles } from "./usePullRequestDiffHighlightFiles";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RegistryContext, useAtomRefresh } from "@effect/atom-react";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";
import { pullRequestConversationThreads, type PullRequestDetail } from "@t3tools/contracts";
import { copyPullRequestLink, sharePullRequestLink } from "./pullRequestLink";
import { use, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { AppBar, type AppBarMenu } from "../../components/ui/AppBar";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAndroidWorkspaceBack } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { usePullRequestLiveChecks } from "./usePullRequestLiveChecks";
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
  usePullRequestVerticalControls,
} from "./PullRequestControls";
import {
  pullRequestTarget as requestTarget,
  usePullRequestDiff,
  usePullRequestDiffEntry,
  type PullRequestDiffParams,
  type PullRequestParams,
  type PullRequestTaskLink,
} from "./usePullRequestDiff";
import { PullRequestReadStatus } from "./PullRequestPresentation";
import { usePullRequestFilesSection } from "./PullRequestFiles";
import { usePullRequestMaintainerEdits } from "./usePullRequestMaintainerEdits";
import { PullRequestDescription } from "./PullRequestDescription";
import { PullRequestMediaVisibleContext } from "./PullRequestMedia";
import { PullRequestMarkdownRepository } from "./PullRequestMarkdown";
import { PullRequestBranchRow } from "./PullRequestStatusRows";
import { PullRequestChecksTab, PullRequestKeyValues } from "./PullRequestDetailHeader";
import {
  DetailHeader,
  DockedTabs,
  LINE_TABS_HEIGHT,
  LineTabs,
  useDockedTabs,
} from "../detail/DetailLayout";
import { PullRequestMergeControls } from "./PullRequestMergeControls";
import { PullRequestStackCard } from "./PullRequestStackCard";
import { usePullRequestStack, type PullRequestStackState } from "./usePullRequestStack";
import { usePullRequestEnvironmentFallback } from "./usePullRequestEnvironmentFallback";
import { pullRequestFileJumpScope, subscribePullRequestFileJump } from "./pullRequestFileJump";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";

function usePullRequestActivityRows(params: PullRequestParams, filter: ActivityFilter) {
  const navigation = useNavigation();
  const messages = useMessages();
  const result = useEnvironmentQuery(composerPullRequests.activity(requestTarget(params)));
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(params)));
  const permissions = usePullRequestPermissions(params, detail.data);
  const filtered = result.data ? filterPullRequestActivity(result.data, filter) : null;
  const rows = (() => {
    if (!filtered) return [];
    const rows = pullRequestTimelineRows(
      filtered.activity,
      params,
      navigation,
      { permissions, onChanged: result.refresh },
      filter.newestFirst,
      messages,
      filter.kind === "all" ? detail.data : null,
    );
    if (!rows.length)
      rows.push({
        key: "empty",
        date: "",
        content: (
          <Text className="px-4 py-6 text-sm text-foreground-muted">
            <T>No activity matches these filters.</T>
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
    comments: result.data?.commentCount ?? 0,
    commits: result.data?.commits.length ?? 0,
    pending: result.isPending && !result.data,
    error: result.error,
  };
}

type PullRequestTab = "description" | "checks" | "timeline" | "code" | "guide";

/** The Checks tab's merge state under the checks: what the checks gate. */
function PullRequestMergeGroup(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  return (
    <View className="gap-5 px-4 pt-5">
      <PullRequestStackCard params={props.params} state={props.stack} />
      <PullRequestCardGroup>
        <Animated.View layout={PR_ROW_LAYOUT}>
          <PullRequestBranchRow pr={props.pr} params={props.params} />
        </Animated.View>
        <Animated.View layout={PR_ROW_LAYOUT}>
          <PullRequestMergeControls pr={props.pr} params={props.params} stack={props.stack} />
        </Animated.View>
      </PullRequestCardGroup>
    </View>
  );
}

function usePullRequestToolbarHeight(bottomInset: number) {
  const { buttonSize } = useAndroidControlSizing();
  return useState(() => (Platform.OS === "android" ? bottomInset + buttonSize + 40 : 0));
}

export function PullRequestRouteScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const returnToList = useAndroidWorkspaceBack();
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const [toolbarHeight, setToolbarHeight] = usePullRequestToolbarHeight(insets.bottom);
  const contentTopInset = useContentTopInset();
  // Only iOS lists run under the bottom safe area; Android's floating toolbar pads its own.
  const contentBottomInset = Platform.OS === "ios" ? insets.bottom : 0;
  const params = route.params;
  usePullRequestEnvironmentFallback(params);
  const connected = usePullRequestConnected(params.environmentId);
  const [chosenSection, setSection] = useState<PullRequestTab>(() => {
    const kind = parsePullRequestAnchor(params.navigationUrl)?.kind;
    return kind === "timeline" || kind === "commits"
      ? "timeline"
      : kind === "checks"
        ? "checks"
        : "description";
  });
  const requestedSection = useRef(chosenSection);
  const [listAnimationsReady, setListAnimationsReady] = useState(false);
  const filesContent = usePullRequestFilesSection(params);
  const guidesEnabled = useReviewGuidesEnabled(params);
  // The guide tab goes away while guides are off and the description stands in. The pick is kept,
  // so guides coming back (a settings reload, a reconnect) return to the guide the user chose.
  const shown = (tab: PullRequestTab) => (!guidesEnabled && tab === "guide" ? "description" : tab);
  const section = shown(chosenSection);
  const activity = usePullRequestActivityFilter(parsePullRequestAnchor(params.navigationUrl)?.kind);
  const activityFilter = activity.filter;
  const activityContent = usePullRequestActivityRows(params, activityFilter);
  const docked = useDockedTabs(contentTopInset);
  const scrollOffsets = useRef<Record<string, number>>({});
  // The offset of the tab last shown, and which tab that was: a tab standing in for a hidden guide
  // has its own offset, which only its next scroll would record here.
  const currentScrollOffset = useRef<{ tab: PullRequestTab; offset: number }>({
    tab: "description",
    offset: -contentTopInset,
  });
  const [viewportHeight, setViewportHeight] = useState(0);
  const scrollViews = useRef<Partial<Record<PullRequestTab, LegendListRef | null>>>({});
  // AnimatedLegendList re-attaches its handle and sets state whenever its ref changes,
  // so an inline ref in the tab map loops the screen into "Maximum update depth exceeded".
  const [listRefs] = useState(() => {
    const listRef = (tab: PullRequestTab) => (list: LegendListRef | null) => {
      scrollViews.current[tab] = list;
    };
    return {
      description: listRef("description"),
      checks: listRef("checks"),
      timeline: listRef("timeline"),
      code: listRef("code"),
      guide: listRef("guide"),
    };
  });
  const selectSection = (next: PullRequestTab) => {
    if (next === section) return;
    const from = shown(requestedSection.current);
    const current =
      currentScrollOffset.current.tab === from
        ? currentScrollOffset.current.offset
        : (scrollOffsets.current[from] ?? -contentTopInset);
    scrollOffsets.current[section] = current;
    // Docked tabs stay docked: the next tab opens where it was, or just under the tabs.
    const headerEnd = docked.dockOffset ?? -contentTopInset;
    const offset = pullRequestTabOffset(current, scrollOffsets.current[next], headerEnd);
    requestedSection.current = next;
    scrollOffsets.current[next] = offset;
    currentScrollOffset.current = { tab: next, offset };
    scrollViews.current[next]?.scrollToOffset({ offset, animated: false });
    docked.onScrollOffset(offset);
    setSection(next);
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
      selectSection("timeline");
      activity.showTimeline();
    } else if (target?.kind === "commits") {
      selectSection("timeline");
      activity.showCommits();
    } else if (target?.kind === "checks") {
      selectSection("checks");
    } else if (target?.kind === "summary") {
      selectSection("description");
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
    void scrollViews.current.timeline?.scrollToIndex({
      index,
      viewPosition: 0,
      viewOffset: contentTopInset + LINE_TABS_HEIGHT + 12,
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
      // Its top sits under the docked tabs; centering a long comment pushed its start off screen.
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
      pullRequestActionLabel("delete-branch", terminology, messages),
      gt("Delete {branch} from {repository}? Local branches and worktrees are not changed.", {
        branch: pr.headBranch,
        repository: pr.headRepositoryNameWithOwner ?? pr.repository,
      }),
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
  // From its task the pull request is one level deeper, so Task goes back up; else it opens it.
  const openTask = (task: PullRequestTaskLink) => {
    const previous = navigation.getState()?.routes.at(-2);
    if (
      previous?.name === "OrbitTask" &&
      Number((previous.params as { taskId?: number } | undefined)?.taskId) === task.id
    )
      navigation.goBack();
    else navigation.dispatch(StackActions.push("OrbitTask", { taskId: task.id }));
  };
  const verticalControls = usePullRequestVerticalControls();
  const pullRequestMenu: AppBarMenu = {
    title: gt(
      "{term, select, mr {Merge request} cr {Change request} other {Pull request}} actions",
      { term: changeRequestTermKind(terminology) },
    ),
    icon: "ellipsis",
    items: [
      ...(permissions.verdicts.length
        ? [
            {
              id: "submit-review",
              title: gt("Submit review"),
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
              title: gt("Add comment"),
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
              title: gt("Edit title"),
              icon: "pencil",
              onPress: () => navigation.navigate("PullRequestEdit", { ...params, field: "title" }),
            },
            {
              id: "edit-description",
              title: gt("Edit description"),
              icon: "doc.text",
              disabled: description.pending,
              subtitle: description.pending ? gt("Saving…") : undefined,
              onPress: () => navigation.navigate("PullRequestEdit", { ...params, field: "body" }),
            },
          ]
        : []),
      ...(maintainerEdits.visible
        ? [
            {
              id: "maintainer-edits",
              title: gt("Allow edits from maintainers"),
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
              title: openOnProviderLabel(identity.provider, messages),
              icon: "arrow.up.right",
              onPress: () => void Linking.openURL(identity.url),
            },
            {
              id: "copy-link",
              title: gt("Copy link"),
              icon: "link",
              onPress: () => copyPullRequestLink(identity),
            },
            {
              id: "share",
              title: gt("Share…"),
              icon: "square.and.arrow.up",
              onPress: () => sharePullRequestLink(identity),
            },
          ]
        : []),
      // Draft, ready and revert: the status menu the old header carried, with its gating.
      ...(["ready", "draft", "revert"] as const).filter(action.available).map((id) => ({
        id,
        title: pullRequestActionLabel(id, terminology, messages),
        icon: PR_ACTION_ICONS[id],
        onPress: () =>
          id === "revert"
            ? action.confirm(
                id,
                pullRequestActionLabel("revert", terminology, messages),
                gt(
                  "Open a new {term, select, mr {merge request} cr {change request} other {pull request}} that reverses these changes?",
                  { term: changeRequestTermKind(terminology) },
                ),
              )
            : void action.perform(id),
      })),
      ...(stateAction
        ? [
            {
              id: "state",
              title: pullRequestActionLabel(stateAction, terminology, messages),
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
              title: pullRequestActionLabel("delete-branch", terminology, messages),
              icon: PR_ACTION_ICONS["delete-branch"],
              destructive: true,
              disabled: !action.available("delete-branch"),
              subtitle: action.busy
                ? gt("Deleting…")
                : connected
                  ? pr.headBranch
                  : gt("Reconnect to delete this branch."),
              onPress: confirmDeleteBranch,
            },
          ]
        : []),
    ],
  };
  const tabs: ReadonlyArray<PullRequestTab> = guidesEnabled
    ? ["description", "checks", "timeline", "code", "guide"]
    : ["description", "checks", "timeline", "code"];
  const tabBar = (
    <LineTabs
      value={section}
      onChange={selectSection}
      items={tabs.map((tab) => ({
        value: tab,
        label:
          tab === "description"
            ? gt("Description")
            : tab === "checks"
              ? gt("Checks")
              : tab === "timeline"
                ? gt("Timeline")
                : tab === "code"
                  ? gt("Code")
                  : gt("Guide", { $context: "review guide tab" }),
      }))}
    />
  );
  const loading = (
    <PullRequestReadStatus
      pending={result.isPending && !pr}
      error={null}
      terminology={terminology}
    />
  );
  const tabBody = (tab: PullRequestTab) => {
    switch (tab) {
      case "description":
        return identity ? (
          <View className="px-4 pt-4">
            <SourceControlAppAccessNotice
              environmentId={params.environmentId}
              provider={identity.provider}
              host={params.host}
              repository={params.repository}
            />
            {pr ? (
              <PullRequestDescription
                heading={false}
                markdown={description.body}
                onTaskListChange={description.toggleTask}
                footer={<PullRequestReactions params={params} />}
              />
            ) : (
              loading
            )}
          </View>
        ) : null;
      case "checks":
        return pr ? (
          <>
            <PullRequestChecksTab pr={pr} params={params} />
            <PullRequestMergeGroup pr={pr} params={params} stack={stack} />
          </>
        ) : (
          loading
        );
      case "timeline":
        return (
          <>
            <PullRequestActivityFilters
              value={activityFilter}
              onChange={activity.setFilter}
              hiddenCount={activityContent.hiddenCount}
              comments={activityContent.comments}
              commits={activityContent.commits}
            />
            <View className="px-4">
              <PullRequestReadStatus
                pending={activityContent.pending}
                error={activityContent.error}
                terminology={terminology}
              />
            </View>
          </>
        );
      case "code":
        return filesContent.header;
      case "guide":
        return (
          <View className="px-4 pt-4">
            <PullRequestGuideContent params={params} visible={section === "guide"} />
          </View>
        );
    }
  };
  return (
    <PullRequestMarkdownRepository params={params} changeRequest={pr}>
      <View className="flex-1 android:bg-header ios:bg-screen">
        <AppBar
          title={`#${params.number}`}
          subtitle={
            connected ? undefined : gt("{repository} · Offline", { repository: params.repository })
          }
          onBack={layout.usesSplitView ? undefined : returnToList}
          menus={verticalControls ? undefined : [pullRequestMenu]}
        />
        <ScreenContent onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}>
          {tabs.map((tab) => (
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
                onScrollBeginDrag={
                  tab === "timeline"
                    ? () => {
                        heldActivityRow.current = null;
                      }
                    : undefined
                }
                onScroll={(event) => {
                  const offset = event.nativeEvent.contentOffset.y;
                  scrollOffsets.current[tab] = offset;
                  if (shown(requestedSection.current) === tab) {
                    currentScrollOffset.current = { tab, offset };
                    docked.onScrollOffset(offset);
                  }
                }}
                scrollEventThrottle={16}
                className="flex-1"
                renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
                contentInsetAdjustmentBehavior="never"
                contentInset={
                  Platform.OS === "ios"
                    ? { top: contentTopInset, bottom: contentBottomInset }
                    : undefined
                }
                refreshControl={
                  <RefreshControl
                    refreshing={section === tab && pullRefresh.refreshing}
                    onRefresh={refresh}
                  />
                }
                alwaysBounceVertical
                scrollsToTop={section === tab}
                onItemSizeChanged={() => {
                  const held = heldActivityRow.current;
                  if (tab !== "timeline" || held === null) return;
                  // A filter or refresh that moved the row ends the hold.
                  if (held !== activityTargetIndex + 1) heldActivityRow.current = null;
                  else positionActivityRow(held);
                }}
                contentContainerStyle={{
                  paddingBottom: 24 + (Platform.OS === "android" ? toolbarHeight : 0),
                  // Short tabs must still be tall enough for the tabs to dock under the bar.
                  minHeight: docked.dockOffset === null ? 0 : docked.dockOffset + viewportHeight,
                }}
                data={[
                  { key: `${tab}:body`, content: tabBody(tab) },
                  ...(tab === "code"
                    ? filesContent.rows
                    : tab === "timeline"
                      ? activityContent.rows
                      : []
                  ).map((row) => ({ key: `${tab}:${row.key}`, content: row.content })),
                ]}
                keyExtractor={(row) => row.key}
                getItemType={(row) => (row.key.endsWith(":body") ? row.key : row.key.split(":")[0])}
                // Animating the description fights clipped markdown; rows can still fade.
                itemLayoutAnimation={tab === "description" ? undefined : PR_ROW_LAYOUT}
                onLoad={() => setListAnimationsReady(true)}
                renderItem={({ item }) => (
                  <Animated.View
                    key={item.key}
                    entering={
                      listAnimationsReady && !item.key.endsWith(":body") ? PR_ROW_ENTER : undefined
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
                estimatedItemSize={tab === "description" ? 64 : 120}
                maintainVisibleContentPosition={false}
                ListHeaderComponent={
                  <View>
                    <PullRequestReadStatus
                      pending={result.isPending && !identity}
                      error={result.error}
                      terminology={terminology}
                    />
                    {identity ? (
                      <>
                        <View onLayout={docked.onHeaderLayout}>
                          <DetailHeader title={identity.title}>
                            <PullRequestKeyValues
                              pr={identity}
                              params={params}
                              onOpenTask={openTask}
                            />
                          </DetailHeader>
                        </View>
                        {tabBar}
                      </>
                    ) : null}
                  </View>
                }
                ListFooterComponent={tab === "code" ? filesContent.footer : null}
              />
            </View>
          ))}
          {identity ? <DockedTabs docked={docked}>{tabBar}</DockedTabs> : null}
        </ScreenContent>
        <PullRequestActionToolbar
          pr={pr}
          params={params}
          menu={pullRequestMenu}
          onOpenFiles={() => selectSection("code")}
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
  const gt = useGT();
  if (ready) return <PullRequestFileRouteContent {...props} />;
  const title = props.route.params.commit ? gt("Commit changes") : gt("Changes");
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={title} onBack={() => navigation.goBack()} />
      <View className="flex-1 items-center justify-center">
        <AppActivityIndicator accessibilityLabel={gt("Loading changes")} />
      </View>
    </View>
  );
}

function PullRequestFileRouteContent({ route }: PullRequestFileRouteProps) {
  const navigation = useNavigation();
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  const [toolbarHeight, setToolbarHeight] = usePullRequestToolbarHeight(insets.bottom);
  const commit = route.params.commit;
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(route.params)));
  const terminology = sourceControlClients.get(
    (detail.data ?? route.params.initialSummary)?.provider,
  ).changeRequest;
  const result = usePullRequestDiff(route.params, terminology);
  // Other screens open files with the link's params spread in; only the link's own entry follows it.
  const linkAnchor =
    route.params.path === "" &&
    (route.params.commit ?? null) === pullRequestLinkCommit(route.params.navigationUrl)
      ? parsePullRequestAnchor(route.params.navigationUrl)
      : null;
  const linkPath =
    linkAnchor?.kind === "diff" && result.parsed.kind === "files"
      ? result.parsed.files.find((file) => pullRequestDiffPathMatches(linkAnchor.digest, file.path))
          ?.path
      : undefined;
  const filter = usePullRequestFileFilter(
    result.parsed,
    linkPath ?? (route.params.focus ? route.params.path : undefined),
  );
  const { refresh: refreshDetail } = detail;
  useFocusEffect(refreshDetail);
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
    !result.withheldRefetching &&
    !result.error;
  const activity = useEnvironmentQuery(composerPullRequests.activity(requestTarget(route.params)));
  const baseData = useMemo(() => getCachedNativeReviewDiffData({ parsedDiff: parsed }), [parsed]);
  const highlightFiles = usePullRequestDiffHighlightFiles(route.params, parsed, baseData.files);
  const data = useMemo(
    () =>
      annotatePullRequestDiff(
        { ...baseData, files: highlightFiles },
        staleDiff || commit ? [] : (activity.data?.reviewThreads ?? []),
        commit ? [] : reviewDraft.draft.comments,
        diffHead.sha ?? undefined,
        messages,
      ),
    [
      baseData,
      highlightFiles,
      staleDiff,
      commit,
      activity.data?.reviewThreads,
      reviewDraft.draft.comments,
      diffHead.sha,
      messages,
    ],
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
  const [pickedPath, setJumpPath] = useState<string | null>(null);
  const jumpPath = pickedPath ?? linkPath ?? route.params.path;
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
  const linkRange = pickedPath === null && linkAnchor?.kind === "diff" ? linkAnchor.range : null;
  const range =
    linkRange &&
    resolvePullRequestAnchorRange(linkRange, (line) =>
      data.rows.some(
        (row) =>
          row.fileId === targetFile?.id && row.change === "delete" && row.oldLineNumber === line,
      ),
    );
  const focus =
    route.params.focus ??
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
  const [foldChoices, setFoldChoices] = useState<FileDiffFoldChoices>(() => new Map());
  const [foldScope, setFoldScope] = useState(`${scopeKey}:${commit ?? "all"}`);
  const [revealedFileId, setRevealedFileId] = useState<string | null>(null);
  if (foldScope !== `${scopeKey}:${commit ?? "all"}`) {
    setFoldScope(`${scopeKey}:${commit ?? "all"}`);
    setFoldChoices(new Map());
    setRevealedFileId(null);
  }
  const requestedFileId =
    (jumpPath ? data.files.find((file) => file.path === jumpPath)?.id : null) ?? null;
  // A linked file must stay open if its Viewed response arrives after the first native draw.
  if (requestedFileId !== revealedFileId) {
    setRevealedFileId(requestedFileId);
    if (requestedFileId)
      setFoldChoices((current) => withFileDiffFold(current, requestedFileId, false));
  }
  const viewedIdSet = new Set(viewedIds);
  const collapsedIds = data.files
    .filter((file) => isFileDiffCollapsed(file.id, null, foldChoices, viewedIdSet.has(file.id)))
    .map((file) => file.id);
  const [visibleFileId, setVisibleFileId] = useState<string | null>(null);
  const nativeView = useRef<NativeReviewDiffViewHandle>(null);
  // The filter the current jump was made under. Hiding or showing test files replaces the rows,
  // so a jump made under the other filter has to run again. Native applies the entry
  // destination before its first viewport, so the first one counts as made.
  const jumpedUnder = useRef<boolean | null>(targetFile ? filter.hideTestFiles : null);
  const hasTestFiles =
    result.parsed.kind === "files" &&
    result.parsed.files.some((file) => isTestChangedFile(file.path));
  const jumpStarted = () =>
    jumpedUnder.current !== null && (!hasTestFiles || jumpedUnder.current === filter.hideTestFiles);
  const scrollToFile = (fileId: string) => {
    if (!nativeView.current) return;
    jumpedUnder.current = filter.hideTestFiles;
    void nativeView.current.scrollToFile(fileId, false).catch(() => {
      jumpedUnder.current = null;
    });
  };
  const jumpScope = pullRequestFileJumpScope(route.params);
  const jumpToFile = useEffectEvent((path: string) => {
    setJumpPath(path);
    setSelectedRowId(null);
    jumpedUnder.current = null;
    const file = data.files.find((entry) => entry.path === path);
    if (!file) return;
    setFoldChoices((current) => withFileDiffFold(current, file.id, false));
    scrollToFile(file.id);
  });
  // Subscribed for the whole screen, so a pick made while the diff is still loading is kept for
  // the first draw.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to pull request file jump requests for the screen's lifetime
  useEffect(() => subscribePullRequestFileJump(jumpScope, (path) => jumpToFile(path)), [jumpScope]);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests the next page of the paged diff query until the jump target file has loaded
  useEffect(() => {
    if (!targetFile) loadMore();
  }, [targetFile, loadMore]);
  const lastFileRowIndex = data.rows.findLastIndex((row) => row.kind === "file");
  const lastFileId = data.rows[lastFileRowIndex]?.fileId;
  const lastShownRowIndex =
    lastFileId && collapsedIds.includes(lastFileId) ? lastFileRowIndex : data.rows.length - 1;
  const onDebug: NonNullable<NativeReviewDiffViewProps["onDebug"]> = (event) =>
    handlePullRequestDiffDebugEvent(event, {
      rowCount: data.rows.length,
      lastShownRowIndex,
      targetFileId: targetFile?.id,
      focusIndex,
      isIos: Platform.OS === "ios",
      nativeView,
      jumpStarted,
      setJumpStarted: (started) => {
        jumpedUnder.current = started ? filter.hideTestFiles : null;
      },
      onDebug: bridge.onDebug,
      loadMore,
    });
  const onToggleFile: NonNullable<NativeReviewDiffViewProps["onToggleFile"]> = (event) => {
    const id = event.nativeEvent.fileId;
    if (!id) return;
    setFoldChoices((current) =>
      withFileDiffFold(current, id, !isFileDiffCollapsed(id, null, current, viewedIdSet.has(id))),
    );
  };
  const visibleFile = data.files.find((file) => file.id === visibleFileId) ?? targetFile;
  const toggleTestFiles = () => {
    setJumpPath(visibleFile?.path ?? route.params.path);
    setSelectedRowId(null);
    filter.toggle();
  };
  const title = commit ? gt("Commit changes") : gt("Changes");
  const seekingFile = !targetFile && result.nextCursor !== null;
  const loadingDiff = (result.isPending && !data.rows.length) || (seekingFile && !result.error);
  const verticalControls = usePullRequestVerticalControls();
  const diffMenu: AppBarMenu = {
    title: gt("Diff options"),
    icon: "ellipsis",
    items: [
      ...(permissions.verdicts.length
        ? [
            {
              id: "submit-review",
              title: gt("Submit review"),
              icon: "text.bubble",
              onPress: () =>
                navigation.navigate("PullRequestReview", {
                  ...route.params,
                  mode: "review",
                }),
            },
          ]
        : []),
      ...(permissions.canComment
        ? [
            {
              id: "comment-on-pr",
              title: gt("Add comment"),
              icon: "plus.bubble",
              onPress: () =>
                navigation.navigate("PullRequestReview", {
                  ...route.params,
                  mode: "comment",
                }),
            },
          ]
        : []),
      {
        id: "word-wrap",
        title: gt("Word wrap"),
        icon: "text.alignleft",
        selected: appearance.codeWordBreak,
        onPress: () => setCodeWordBreak(!appearance.codeWordBreak),
      },
      {
        id: "hide-tests",
        title: gt("Hide test files"),
        icon: "line.3.horizontal.decrease",
        selected: filter.hideTestFiles,
        onPress: toggleTestFiles,
      },
      ...(selectedRow && selectedFile && canCommentOnDiff
        ? [
            {
              id: "comment",
              title: route.params.replacingDraftId
                ? gt("Move draft to this line")
                : gt("Add review comment"),
              icon: "bubble.left",
              onPress: () => commentOnLine(),
            },
          ]
        : []),
      ...(selectedRow && selectedFile
        ? [
            {
              id: "copy",
              title: gt("Copy line"),
              icon: "document.on.document",
              onPress: () => void Clipboard.setStringAsync(selectedRow.content ?? ""),
            },
          ]
        : []),
    ],
  };
  return (
    <View className="flex-1 android:bg-header ios:bg-screen">
      <AppBar
        title={title}
        subtitle={`${commit ? commit.slice(0, 7) : `#${route.params.number}`} · ${gt(
          "{count, plural, one {{count} file} other {{count} files}}",
          { count: data.files.length },
        )}${
          filter.hideTestFiles && filter.hiddenCount
            ? ` · ${gt("{count, plural, one {{count} test hidden} other {{count} tests hidden}}", {
                count: filter.hiddenCount,
              })}`
            : ""
        }`}
        onBack={() => navigation.goBack()}
        menus={verticalControls ? undefined : [diffMenu]}
      />
      {route.params.replacingDraftId ? (
        <Text className="px-4 py-2 text-xs text-foreground-muted">
          <T>Select a current line, then choose “Move draft to this line” from its menu.</T>
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
            <T>The branch changed. Reload before adding line comments.</T>
          </Text>
          <Button
            label={gt("Reload changes")}
            onPress={() => {
              result.refresh();
              setDiffHead({ scopeKey, sha: detail.data?.headSha ?? null });
              jumpedUnder.current = null;
              setSelectedRowId(null);
              setFoldChoices(new Map());
            }}
          />
        </View>
      ) : null}
      <ScreenContent>
        <View className="flex-1" collapsable={false}>
          {loadingDiff || result.error ? (
            <View style={{ paddingTop: staleDiff ? 0 : contentTopInset }}>
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
                selectedRowIdsJson={bridge.selectedRowIdsJson}
                onPressLine={(event) => {
                  const rowId = event.nativeEvent.rowId ?? null;
                  setSelectedRowId(rowId);
                  if (event.nativeEvent.gesture !== "longPress") commentOnLine(rowId);
                }}
                onToggleViewedFile={(event) => {
                  const file = data.files.find((file) => file.id === event.nativeEvent.fileId);
                  if (!file || (!commit && !viewed.canToggle)) return;
                  setFoldChoices((current) => withFileDiffFold(current, file.id, undefined));
                  if (commit)
                    setCommitViewedPaths((current) => {
                      const next = new Set(current);
                      if (next.has(file.path)) next.delete(file.path);
                      else next.add(file.path);
                      return next;
                    });
                  else void viewed.toggle(file.path);
                }}
                onPressNotice={(event) => {
                  const file = data.files.find((file) => file.id === event.nativeEvent.fileId);
                  if (file) result.loadWithheldFile(file.path);
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
                contentInsetTop={staleDiff ? 0 : contentTopInset}
                contentInsetBottom={Platform.OS === "android" ? toolbarHeight : insets.bottom}
                contentResetKey={`pull-request:${route.params.environmentId}:${route.params.repository}:${route.params.number}:${commit ?? "all"}`}
              />
            </View>
          ) : filter.hiddenCount > 0 &&
            !data.rows.length &&
            !result.isPending &&
            !result.error &&
            !seekingFile ? (
            <View style={{ paddingTop: contentTopInset }}>
              <EmptyState
                title={gt("Only test files changed")}
                detail={gt("Test files are hidden from this review.")}
                action={
                  <Button label={gt("Show test files")} tone="contrast" onPress={filter.showAll} />
                }
                variant="plain"
              />
            </View>
          ) : !result.isPending && !result.error && !seekingFile ? (
            <EmptyState
              title={gt("Diff unavailable")}
              detail={gt(
                "Open this {term, select, mr {merge request} cr {change request} other {pull request}} on its provider to view the changes.",
                {
                  term: changeRequestTermKind(terminology),
                },
              )}
              variant="plain"
            />
          ) : null}
          {result.nextCursor && result.isPending && data.rows.length && !seekingFile ? (
            <View className="flex-row items-center justify-center gap-2 py-2">
              <AppActivityIndicator size="small" />
              <Text className="text-xs text-foreground-muted">
                <T>Loading more files…</T>
              </Text>
            </View>
          ) : null}
          {result.error && result.nextCursor ? (
            <View className="self-center">
              <Button
                label={gt("Retry loading remaining files")}
                tone="text"
                onPress={result.refresh}
              />
            </View>
          ) : null}
          {parsed.kind === "files" && parsed.notice ? (
            <Text className="px-4 py-2 text-2xs text-foreground-muted">{parsed.notice}</Text>
          ) : null}
        </View>
      </ScreenContent>
      <PullRequestActionToolbar
        pr={detail.data}
        params={route.params}
        filePath={visibleFile?.path}
        menu={diffMenu}
        onOpenFiles={() => navigation.navigate("PullRequestFiles", route.params)}
        onHeightChange={setToolbarHeight}
      />
    </View>
  );
}
