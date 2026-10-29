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
import { relativeTime } from "../../lib/time";
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

const EMPTY_IDS: readonly string[] = [];

function PullRequestTabScrollView(props: ScrollViewProps) {
  return (
    <ScrollViewMarker style={{ flex: 1 }}>
      <ScrollView {...props} />
    </ScrollViewMarker>
  );
}

function usePullRequestActivityRows(params: PullRequestParams, filter: ActivityFilter) {
  const navigation = useNavigation();
  const result = useEnvironmentQuery(composerPullRequests.activity(requestTarget(params)));
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(params)));
  const permissions = usePullRequestPermissions(params, detail.data);
  const filtered = result.data ? filterPullRequestActivity(result.data, filter) : null;
  const rows = (() => {
    if (!filtered) return [];
    const rows = pullRequestTimelineRows(filtered.activity, params, navigation, {
      permissions,
      onChanged: result.refresh,
    });
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
  return {
    rows,
    hiddenCount: filtered?.hiddenCount ?? 0,
    pending: result.isPending && !result.data,
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
          markdown={pr.body}
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
      <NativeStackScreenOptions options={{ title, headerTitle: title }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
      ) : null}
      <View className="flex-1 items-center justify-center">
        <AppActivityIndicator accessibilityLabel="Loading changes" />
      </View>
    </View>
  );
}

function PullRequestFileRouteContent({ route }: PullRequestFileRouteProps) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [toolbarHeight, setToolbarHeight] = usePullRequestToolbarHeight(insets.bottom);
  const commit = route.params.commit;
  const detail = useEnvironmentQuery(composerPullRequests.detail(requestTarget(route.params)));
  const terminology = sourceControlClients.get(
    (detail.data ?? route.params.initialSummary)?.provider,
  ).changeRequest;
  const result = usePullRequestDiff(route.params, terminology);
  const filter = usePullRequestFileFilter(
    result.parsed,
    route.params.focus ? route.params.path : undefined,
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
      ),
    [
      baseData,
      highlightFiles,
      staleDiff,
      commit,
      activity.data?.reviewThreads,
      reviewDraft.draft.comments,
      diffHead.sha,
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
  // The filter the current jump was made under. Hiding or showing test files replaces the rows,
  // so a jump made under the other filter has to run again. Native applies the entry
  // destination before its first viewport, so the first one counts as made.
  const jumpedUnder = useRef<boolean | null>(filter.hideTestFiles);
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
    setCollapsedIds((ids) => ids.filter((id) => id !== file.id));
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
  const onDebug: NonNullable<NativeReviewDiffViewProps["onDebug"]> = (event) =>
    handlePullRequestDiffDebugEvent(event, {
      rowCount: data.rows.length,
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
    setCollapsedIds((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
    );
  };
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
      <Toolbar placement="right">
        <Toolbar.Menu title="Diff options" accessibilityLabel="Diff options" icon="ellipsis">
          {permissions.verdicts.length ? (
            <Toolbar.MenuAction
              icon="text.bubble"
              onPress={() =>
                navigation.navigate("PullRequestReview", { ...route.params, mode: "review" })
              }
            >
              <Toolbar.Label>Submit review</Toolbar.Label>
            </Toolbar.MenuAction>
          ) : null}
          {permissions.canComment ? (
            <Toolbar.MenuAction
              icon="plus.bubble"
              onPress={() =>
                navigation.navigate("PullRequestReview", { ...route.params, mode: "comment" })
              }
            >
              <Toolbar.Label>Add comment</Toolbar.Label>
            </Toolbar.MenuAction>
          ) : null}
          <Toolbar.MenuAction
            icon="text.alignleft"
            isOn={appearance.codeWordBreak}
            onPress={() => setCodeWordBreak(!appearance.codeWordBreak)}
          >
            <Toolbar.Label>Word wrap</Toolbar.Label>
          </Toolbar.MenuAction>
          <Toolbar.MenuAction
            icon="line.3.horizontal.decrease"
            isOn={filter.hideTestFiles}
            onPress={toggleTestFiles}
          >
            <Toolbar.Label>Hide test files</Toolbar.Label>
          </Toolbar.MenuAction>
          {selectedRow && selectedFile && canCommentOnDiff ? (
            <Toolbar.MenuAction icon="bubble.left" onPress={() => commentOnLine()}>
              <Toolbar.Label>
                {route.params.replacingDraftId ? "Move draft to this line" : "Add review comment"}
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
        </Toolbar.Menu>
      </Toolbar>
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
              jumpedUnder.current = null;
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
