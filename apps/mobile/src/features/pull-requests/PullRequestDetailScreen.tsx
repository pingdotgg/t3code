import type {
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { MenuAction } from "@react-native-menu/menu";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ACTION_FAILURE_HINTS,
  ACTION_FAILURE_LABELS,
  ACTION_SUCCESS_LABELS,
  OPEN_ON_HOST_LABELS,
  allowedPullRequestReviewVerdicts,
  buildExplainPullRequestPrompt,
  buildFixFindingPrompt,
  buildFixFindingsPrompt,
  buildPullRequestTimeline,
  buildResolveConflictsPrompt,
  canRequestPullRequestReviewers,
  composePullRequestDetailView,
  countUnresolvedReviewThreads,
  describePullRequestConversationSummary,
  groupPullRequestConversation,
  pullRequestUrlHost,
  readableFailure,
} from "./pullRequestDetail.logic";
import type { ParsedDiffFile } from "./pullRequestDiffParse";
import {
  formatDiffStat,
  pullRequestCheckStatusLabel,
  pullRequestCheckSymbol,
  resolvePullRequestState,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";
import { parseRoutePositiveInt, type PullRequestDetailRouteParams } from "./pullRequestNavigation";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestStateBadge } from "./PullRequestStateBadge";
import { usePullRequestDiffSlices } from "./usePullRequestDiffSlices";
import { usePullRequestHandoff } from "./usePullRequestHandoff";
import { useResolvedPullRequestReference } from "./useResolvedPullRequestReference";

type DetailTab = "overview" | "conversation" | "files";

const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "conversation", label: "Conversation" },
  { value: "files", label: "Files" },
];

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

type PullRequestDetailScreenProps = StaticScreenProps<PullRequestDetailRouteParams>;

export function PullRequestDetailScreen(props: PullRequestDetailScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const number = parseRoutePositiveInt(props.route.params.number);
  const reference = useResolvedPullRequestReference(props.route.params);
  const repository = reference?.repository ?? props.route.params.repository ?? "";
  const [tab, setTab] = useState<DetailTab>("overview");
  const [actionPending, setActionPending] = useState(false);
  const { pendingKind, startHandoff } = usePullRequestHandoff();
  const skipFocusRefresh = useRef(true);

  const detailQuery = useEnvironmentQuery(
    reference === null ? null : pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const activityQuery = useEnvironmentQuery(
    reference === null
      ? null
      : pullRequestEnvironment.activity({ environmentId, input: reference }),
  );
  const diffSlices = usePullRequestDiffSlices({
    environmentId,
    reference,
    enabled: reference !== null && tab === "files" && detailQuery.data?.capabilities.diff === true,
  });
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });

  const detail =
    detailQuery.data === null
      ? null
      : composePullRequestDetailView(detailQuery.data, activityQuery.data);
  const presentation = detail === null ? null : resolvePullRequestState(detail);
  const visibleTabs = useMemo(
    () =>
      TABS.filter((item) => item.value !== "files" || detail === null || detail.capabilities.diff),
    [detail],
  );
  const reviewVerdicts = useMemo(
    () =>
      detail === null
        ? []
        : allowedPullRequestReviewVerdicts(
            detail.capabilities.review.verdicts,
            detail.viewerPermissions.verdicts,
          ),
    [detail],
  );

  useEffect(() => {
    if (!visibleTabs.some((item) => item.value === tab)) setTab("overview");
  }, [tab, visibleTabs]);

  const refetch = useCallback(() => {
    detailQuery.refresh();
    activityQuery.refresh();
    diffSlices.refresh();
  }, [activityQuery, detailQuery, diffSlices]);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  const refresh = useCallback(
    async (scope: "one" | "all" = "one") => {
      if (reference === null) return;
      await invalidate({
        environmentId,
        input: scope === "all" ? {} : { reference },
      });
      refetchRef.current();
    },
    [environmentId, invalidate, reference],
  );

  useFocusEffect(
    useCallback(() => {
      if (skipFocusRefresh.current) {
        skipFocusRefresh.current = false;
        return;
      }
      refetchRef.current();
    }, []),
  );

  const can = useCallback(
    (action: PullRequestAction) =>
      detail !== null &&
      detail.capabilities.actions.includes(action) &&
      detail.viewerPermissions.actions.includes(action),
    [detail],
  );

  const perform = useCallback(
    async (action: PullRequestAction, mergeMethod?: PullRequestMergeMethod) => {
      if (reference === null || actionPending) return;
      setActionPending(true);
      try {
        const result = await runAction({
          environmentId,
          input: { ...reference, action, ...(mergeMethod ? { mergeMethod } : {}) },
        });
        if (AsyncResult.isFailure(result)) {
          Alert.alert(
            ACTION_FAILURE_LABELS[action],
            readableFailure(squashAtomCommandFailure(result), ACTION_FAILURE_HINTS[action]),
          );
          return;
        }
        Alert.alert(ACTION_SUCCESS_LABELS[action]);
        await refresh("all");
      } finally {
        setActionPending(false);
      }
    },
    [actionPending, environmentId, reference, refresh, runAction],
  );

  const mergeMethods = useMemo(() => {
    if (detail === null) return [];
    return (["merge", "squash", "rebase"] as const).filter(
      (method) =>
        detail.mergeCapabilities[method] && detail.capabilities.mergeMethods.includes(method),
    );
  }, [detail]);

  const confirmMerge = useCallback(() => {
    if (mergeMethods.length === 0) return;
    if (mergeMethods.length === 1) {
      void perform("merge", mergeMethods[0]);
      return;
    }
    Alert.alert("Merge pull request", "Choose how to merge this pull request.", [
      { text: "Cancel", style: "cancel" },
      ...mergeMethods.map((method) => ({
        text: MERGE_METHOD_LABELS[method],
        onPress: () => void perform("merge", method),
      })),
    ]);
  }, [mergeMethods, perform]);

  const androidMergeActions = useMemo<MenuAction[]>(
    () =>
      mergeMethods.map((method) => ({
        id: method,
        title: MERGE_METHOD_LABELS[method],
      })),
    [mergeMethods],
  );

  const handoff = useCallback(
    async (kind: string, prompt: string) => {
      if (detail === null) return;
      await startHandoff({
        kind,
        environmentId,
        projectId: detail.projectId,
        url: detail.url,
        prompt,
      });
    },
    [detail, environmentId, startHandoff],
  );

  const openOnHost = useCallback(() => {
    if (detail === null) return;
    void tryOpenExternalUrl(detail.url, "pull-request");
  }, [detail]);

  const openReview = useCallback(() => {
    navigation.navigate("PullRequestComment", {
      environmentId: String(environmentId),
      projectId: props.route.params.projectId,
      repository,
      number: String(number),
      mode: "review",
      verdicts: reviewVerdicts,
    });
  }, [environmentId, navigation, number, props.route.params.projectId, repository, reviewVerdicts]);

  const moreItems = useMemo(() => {
    if (detail === null) return [];
    const items: Array<{
      type: "action";
      title: string;
      onPress: () => void;
      destructive?: boolean;
    }> = [
      { type: "action", title: "Refresh", onPress: () => void refresh() },
      {
        type: "action",
        title: OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host",
        onPress: openOnHost,
      },
      {
        type: "action",
        title: "Explain this PR",
        onPress: () =>
          void handoff(
            "explain",
            buildExplainPullRequestPrompt({
              number: detail.number,
              title: detail.title,
              url: detail.url,
              headBranch: detail.headBranch,
              baseBranch: detail.baseBranch,
            }),
          ),
      },
      {
        type: "action",
        title: "Fix findings in a thread",
        onPress: () =>
          void handoff(
            "findings",
            buildFixFindingsPrompt({
              provider: detail.provider,
              host: pullRequestUrlHost(detail.url) ?? detail.repository,
              number: detail.number,
              title: detail.title,
              url: detail.url,
              headBranch: detail.headBranch,
              baseBranch: detail.baseBranch,
              reviewThreads: detail.reviewThreads,
              comments: detail.comments,
              checks: detail.checks,
              commentsTruncated: detail.commentsTruncated,
              canResolve: detail.viewerPermissions.resolve && detail.capabilities.review.resolve,
            }),
          ),
      },
    ];
    if (detail.state === "open" && detail.isDraft && can("ready")) {
      items.push({
        type: "action",
        title: "Mark ready for review",
        onPress: () => void perform("ready"),
      });
    }
    if (detail.state === "open" && !detail.isDraft && can("draft")) {
      items.push({
        type: "action",
        title: "Convert to draft",
        onPress: () => void perform("draft"),
      });
    }
    if (canRequestPullRequestReviewers(detail)) {
      items.push({
        type: "action",
        title: "Request reviewers",
        onPress: () =>
          navigation.navigate("PullRequestReviewers", {
            environmentId: String(environmentId),
            projectId: props.route.params.projectId,
            repository,
            number: String(number),
          }),
      });
    }
    if (detail.state === "open" && can("close")) {
      items.push({
        type: "action",
        title: "Close pull request",
        destructive: true,
        onPress: () =>
          Alert.alert("Close pull request", "Close this pull request on the host?", [
            { text: "Cancel", style: "cancel" },
            { text: "Close", style: "destructive", onPress: () => void perform("close") },
          ]),
      });
    }
    if (detail.state === "closed" && can("reopen")) {
      items.push({
        type: "action",
        title: "Reopen pull request",
        onPress: () => void perform("reopen"),
      });
    }
    return items;
  }, [
    can,
    detail,
    environmentId,
    handoff,
    navigation,
    number,
    openOnHost,
    perform,
    props.route.params.projectId,
    refresh,
    repository,
  ]);

  const androidMoreActions = useMemo<MenuAction[]>(
    () =>
      moreItems.map((item, index) => ({
        id: String(index),
        title: item.title,
        attributes: item.destructive ? { destructive: true } : undefined,
      })),
    [moreItems],
  );

  const conversation = useMemo(
    () =>
      detail === null
        ? []
        : groupPullRequestConversation(detail.comments, detail.reviewThreads, "oldest"),
    [detail],
  );
  const timeline = useMemo(
    () => (detail === null ? [] : buildPullRequestTimeline(detail)),
    [detail],
  );

  const conflicting = detail?.mergeability === "conflicting";
  const canMerge =
    detail !== null &&
    detail.state === "open" &&
    !detail.isDraft &&
    can("merge") &&
    mergeMethods.length > 0;
  const busy = actionPending || pendingKind !== null;

  if (number === null || reference === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-8">
        <EmptyState
          title="Pull request not found"
          detail={
            number === null
              ? "This link does not name a pull request."
              : "This link does not name a repository. Open the pull request from the list, or from a project that has a repository identity."
          }
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={detail ? `#${detail.number}` : "Pull request"}
            subtitle={repository}
            onBack={() => navigation.goBack()}
            trailing={
              moreItems.length === 0 ? null : (
                <ControlPillMenu
                  title="Pull request"
                  actions={androidMoreActions}
                  isAnchoredToRight
                  onPressAction={({ nativeEvent }) => {
                    moreItems[Number(nativeEvent.event)]?.onPress();
                  }}
                >
                  <AndroidHeaderIconButton accessibilityLabel="More actions" icon="ellipsis" />
                </ControlPillMenu>
              )
            }
          />
        </>
      ) : (
        <NativeStackScreenOptions
          optionsVersion={moreItems.map((item) => item.title)}
          options={{
            title: detail ? `#${detail.number}` : "Pull request",
            headerTintColor: iconColor,
            unstable_headerRightItems: () => [
              withNativeGlassHeaderItem({
                type: "menu",
                label: "",
                accessibilityLabel: "More actions",
                icon: { name: "ellipsis", type: "sfSymbol" },
                menu: {
                  title: "Pull request",
                  items: moreItems.map((item) => ({
                    type: "action" as const,
                    label: item.title,
                    onPress: item.onPress,
                    destructive: item.destructive === true,
                  })),
                },
              }),
            ],
          }}
        />
      )}

      {detailQuery.isPending && detail === null ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={iconColor} />
        </View>
      ) : detailQuery.error && detail === null ? (
        <View className="flex-1 justify-center px-6">
          <EmptyState
            title="Could not load this pull request"
            detail={detailQuery.error}
            actionLabel="Retry"
            onAction={() => void refresh()}
          />
        </View>
      ) : detail === null || presentation === null ? null : (
        <>
          <View className="px-4 pb-2 pt-3">
            <View className="flex-row items-center gap-2">
              <PullRequestStateBadge
                isDraft={detail.isDraft}
                mergeability={detail.mergeability}
                state={detail.state}
                baseBranch={detail.baseBranch}
              />
              <Text className="flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                {detail.repository}
              </Text>
            </View>
            <Text className="mt-2 text-xl font-t3-bold leading-snug text-foreground">
              {detail.title}
            </Text>
            <View className="mt-3 flex-row rounded-full bg-subtle p-1">
              {visibleTabs.map((item) => {
                const selected = tab === item.value;
                return (
                  <Pressable
                    key={item.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setTab(item.value)}
                    className={cn(
                      "flex-1 items-center rounded-full py-2",
                      selected ? "bg-card" : undefined,
                    )}
                  >
                    <Text
                      className={cn(
                        "text-sm font-t3-bold",
                        selected ? "text-foreground" : "text-foreground-muted",
                      )}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120 }}
            contentInsetAdjustmentBehavior="automatic"
            refreshControl={
              <RefreshControl
                refreshing={detailQuery.isPending && detail !== null}
                onRefresh={() => void refresh()}
                tintColor={String(iconColor)}
              />
            }
          >
            {tab === "overview" ? (
              <OverviewTab
                detail={detail}
                onRequestReviewers={() =>
                  navigation.navigate("PullRequestReviewers", {
                    environmentId: String(environmentId),
                    projectId: props.route.params.projectId,
                    repository,
                    number: String(number),
                  })
                }
              />
            ) : null}
            {tab === "conversation" ? (
              activityQuery.isPending && activityQuery.data === null ? (
                <View className="items-center py-16">
                  <ActivityIndicator color={iconColor} />
                </View>
              ) : activityQuery.error && activityQuery.data === null ? (
                <EmptyState
                  title="Could not load the conversation"
                  detail={activityQuery.error}
                  actionLabel="Retry"
                  onAction={() => activityQuery.refresh()}
                />
              ) : (
                <ConversationTab
                  busy={busy}
                  canReview={reviewVerdicts.length > 0}
                  conversation={conversation}
                  detail={detail}
                  timeline={timeline}
                  onComment={() =>
                    navigation.navigate("PullRequestComment", {
                      environmentId: String(environmentId),
                      projectId: props.route.params.projectId,
                      repository,
                      number: String(number),
                      mode: "comment",
                    })
                  }
                  onFixThread={(thread) =>
                    void handoff(
                      `finding:thread:${thread.id}`,
                      buildFixFindingPrompt({
                        provider: detail.provider,
                        host: pullRequestUrlHost(detail.url) ?? detail.repository,
                        number: detail.number,
                        title: detail.title,
                        url: detail.url,
                        headBranch: detail.headBranch,
                        baseBranch: detail.baseBranch,
                        finding: { kind: "thread", thread },
                        canResolve:
                          detail.viewerPermissions.resolve && detail.capabilities.review.resolve,
                      }),
                    )
                  }
                  onReply={(threadId) =>
                    navigation.navigate("PullRequestComment", {
                      environmentId: String(environmentId),
                      projectId: props.route.params.projectId,
                      repository,
                      number: String(number),
                      mode: "reply",
                      threadId,
                    })
                  }
                  onReview={openReview}
                  onToggleResolved={async (thread, resolved) => {
                    const result = await setThreadResolution({
                      environmentId,
                      input: { ...reference, threadId: thread.id, resolved },
                    });
                    if (AsyncResult.isFailure(result)) {
                      Alert.alert(
                        resolved ? "Could not resolve" : "Could not unresolve",
                        readableFailure(
                          squashAtomCommandFailure(result),
                          "The host refused to change this conversation.",
                        ),
                      );
                      return;
                    }
                    await invalidate({ environmentId, input: { reference } });
                    activityQuery.refresh();
                  }}
                />
              )
            ) : null}
            {tab === "files" ? (
              <FilesTab
                error={diffSlices.error}
                files={diffSlices.files}
                loading={diffSlices.loading}
                loadingMore={diffSlices.loadingMore}
                nextCursor={diffSlices.nextCursor}
                truncated={diffSlices.truncated}
                onLoadMore={diffSlices.loadMore}
                onOpenFile={(path) =>
                  navigation.navigate("PullRequestDiff", {
                    environmentId: String(environmentId),
                    projectId: props.route.params.projectId,
                    repository,
                    number: String(number),
                    path,
                  })
                }
              />
            ) : null}
          </ScrollView>

          {detail.state === "open" ? (
            <View
              className="absolute inset-x-0 bottom-0 border-t border-border bg-sheet px-4 pt-3"
              style={{ paddingBottom: Math.max(insets.bottom, 12) }}
            >
              {conflicting ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void handoff(
                      "conflicts",
                      buildResolveConflictsPrompt({
                        number: detail.number,
                        url: detail.url,
                        headBranch: detail.headBranch,
                        baseBranch: detail.baseBranch,
                      }),
                    )
                  }
                  className="h-12 items-center justify-center rounded-full bg-danger active:opacity-80"
                >
                  <Text className="text-base font-t3-bold text-danger-foreground">
                    {pendingKind === "conflicts" ? "Preparing…" : "Resolve conflicts in a thread"}
                  </Text>
                </Pressable>
              ) : canMerge ? (
                Platform.OS === "android" && androidMergeActions.length > 1 ? (
                  <ControlPillMenu
                    title="Merge pull request"
                    actions={androidMergeActions}
                    onPressAction={({ nativeEvent }) => {
                      void perform("merge", nativeEvent.event as PullRequestMergeMethod);
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      className="h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
                    >
                      <Text className="text-base font-t3-bold text-primary-foreground">
                        {actionPending ? "Merging…" : "Merge pull request"}
                      </Text>
                    </Pressable>
                  </ControlPillMenu>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={confirmMerge}
                    className="h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
                  >
                    <Text className="text-base font-t3-bold text-primary-foreground">
                      {actionPending ? "Merging…" : "Merge pull request"}
                    </Text>
                  </Pressable>
                )
              ) : reviewVerdicts.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={openReview}
                  className="h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
                >
                  <Text className="text-base font-t3-bold text-primary-foreground">
                    Submit a review
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function OverviewTab(props: {
  readonly detail: NonNullable<ReturnType<typeof composePullRequestDetailView>>;
  readonly onRequestReviewers: () => void;
}) {
  const { detail } = props;
  const muted = String(useThemeColor("--color-icon-subtle"));
  const diff = formatDiffStat(detail.additions, detail.deletions);
  return (
    <View className="gap-4 pt-2">
      <View className="rounded-[20px] bg-card px-4 py-3">
        <MetaLine
          icon="arrow.triangle.branch"
          tint={muted}
          label={`${detail.headBranch} → ${detail.baseBranch}`}
        />
        <MetaLine
          icon="person.crop.circle"
          tint={muted}
          label={`${detail.author?.login ?? "ghost"} opened ${relativeTime(detail.createdAt)}`}
        />
        {diff ? (
          <MetaLine icon="doc.text" tint={muted} label={`${diff} · ${detail.changedFiles} files`} />
        ) : null}
        <MetaLine
          icon="checkmark.circle"
          tint={muted}
          label={summarizePullRequestChecks(detail.checks)}
        />
      </View>

      {detail.reviewers.length > 0 || canRequestPullRequestReviewers(detail) ? (
        <View className="rounded-[20px] bg-card px-4 py-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-t3-bold text-foreground">Reviewers</Text>
            {canRequestPullRequestReviewers(detail) ? (
              <Pressable onPress={props.onRequestReviewers} hitSlop={8}>
                <Text className="text-sm font-t3-bold text-primary">Edit</Text>
              </Pressable>
            ) : null}
          </View>
          {detail.reviewers.length === 0 ? (
            <Text className="mt-2 text-sm text-foreground-muted">No reviewers requested</Text>
          ) : (
            detail.reviewers.map((reviewer) => (
              <Text key={reviewer.login} className="mt-1.5 text-sm text-foreground">
                {reviewer.name ?? reviewer.login}
              </Text>
            ))
          )}
        </View>
      ) : null}

      {detail.checks.length > 0 ? (
        <View className="rounded-[20px] bg-card px-4 py-3">
          <Text className="text-sm font-t3-bold text-foreground">Checks</Text>
          {detail.checks.map((check) => (
            <View
              key={`${check.name}:${check.url ?? ""}`}
              className="mt-2 flex-row items-center gap-2"
            >
              <SymbolView
                name={pullRequestCheckSymbol(check.status)}
                size={14}
                tintColor={muted}
                type="monochrome"
              />
              <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                {check.name}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {pullRequestCheckStatusLabel(check.status)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {detail.body.trim().length > 0 ? (
        <View className="rounded-[20px] bg-card px-4 py-3">
          <Text className="mb-2 text-sm font-t3-bold text-foreground">Description</Text>
          <PullRequestMarkdown markdown={detail.body} />
        </View>
      ) : null}
    </View>
  );
}

function MetaLine(props: {
  readonly icon: Parameters<typeof SymbolView>[0]["name"];
  readonly tint: string;
  readonly label: string;
}) {
  return (
    <View className="flex-row items-center gap-2 py-1.5">
      <SymbolView name={props.icon} size={14} tintColor={props.tint} type="monochrome" />
      <Text className="flex-1 text-sm text-foreground" numberOfLines={2}>
        {props.label}
      </Text>
    </View>
  );
}

function ConversationTab(props: {
  readonly detail: NonNullable<ReturnType<typeof composePullRequestDetailView>>;
  readonly conversation: ReturnType<typeof groupPullRequestConversation>;
  readonly timeline: ReturnType<typeof buildPullRequestTimeline>;
  readonly busy: boolean;
  readonly onComment: () => void;
  readonly onReview: () => void;
  readonly canReview: boolean;
  readonly onReply: (threadId: string) => void;
  readonly onFixThread: (thread: PullRequestReviewThread) => void;
  readonly onToggleResolved: (thread: PullRequestReviewThread, resolved: boolean) => Promise<void>;
}) {
  const muted = String(useThemeColor("--color-icon-subtle"));
  const unresolved = countUnresolvedReviewThreads(props.detail.reviewThreads);
  const summary = describePullRequestConversationSummary({
    commentCount: props.detail.commentCount,
    unresolvedThreadCount: unresolved,
    resolvedThreadCount: props.detail.reviewThreads.length - unresolved,
  });
  return (
    <View className="gap-3 pt-2">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm text-foreground-muted">{summary}</Text>
        <View className="flex-row gap-2">
          {props.detail.viewerPermissions.comment ? (
            <Pressable onPress={props.onComment} className="rounded-full bg-subtle px-3 py-1.5">
              <Text className="text-xs font-t3-bold text-foreground">Comment</Text>
            </Pressable>
          ) : null}
          {props.canReview ? (
            <Pressable onPress={props.onReview} className="rounded-full bg-subtle px-3 py-1.5">
              <Text className="text-xs font-t3-bold text-foreground">Review</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {props.conversation.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No conversation yet"
          detail="Comments and review threads will appear here."
        />
      ) : (
        props.conversation.map((item) => {
          if (item.kind === "comment") {
            return (
              <View key={item.comment.id} className="rounded-[20px] bg-card px-4 py-3">
                <Text className="text-xs text-foreground-muted">
                  {item.comment.author?.login ?? "ghost"} · {relativeTime(item.comment.createdAt)}
                  {item.comment.reviewState ? ` · ${item.comment.reviewState}` : ""}
                </Text>
                {item.comment.body.trim().length > 0 ? (
                  <View className="mt-2">
                    <PullRequestMarkdown markdown={item.comment.body} />
                  </View>
                ) : null}
              </View>
            );
          }
          const thread = item.thread;
          return (
            <View key={thread.id} className="rounded-[20px] bg-card px-4 py-3">
              <View className="flex-row items-center gap-2">
                <SymbolView name="text.bubble" size={13} tintColor={muted} type="monochrome" />
                <Text
                  className="flex-1 text-xs font-t3-medium text-foreground-muted"
                  numberOfLines={1}
                >
                  {thread.path}
                  {thread.line === null ? "" : `:${thread.line}`}
                  {thread.isResolved ? " · Resolved" : ""}
                </Text>
              </View>
              {thread.comments.map((comment) => (
                <View key={comment.id} className="mt-2">
                  <Text className="text-xs text-foreground-muted">
                    {comment.author?.login ?? "ghost"} · {relativeTime(comment.createdAt)}
                  </Text>
                  {comment.body.trim().length > 0 ? (
                    <View className="mt-1">
                      <PullRequestMarkdown markdown={comment.body} />
                    </View>
                  ) : null}
                </View>
              ))}
              <View className="mt-3 flex-row flex-wrap gap-2">
                {props.detail.capabilities.review.reply &&
                props.detail.viewerPermissions.comment ? (
                  <Pressable
                    onPress={() => props.onReply(thread.id)}
                    className="rounded-full bg-subtle px-3 py-1.5"
                  >
                    <Text className="text-xs font-t3-bold text-foreground">Reply</Text>
                  </Pressable>
                ) : null}
                {props.detail.capabilities.review.resolve &&
                props.detail.viewerPermissions.resolve ? (
                  <Pressable
                    disabled={props.busy}
                    onPress={() => void props.onToggleResolved(thread, !thread.isResolved)}
                    className="rounded-full bg-subtle px-3 py-1.5"
                  >
                    <Text className="text-xs font-t3-bold text-foreground">
                      {thread.isResolved ? "Unresolve" : "Resolve"}
                    </Text>
                  </Pressable>
                ) : null}
                {!thread.isResolved ? (
                  <Pressable
                    disabled={props.busy}
                    onPress={() => props.onFixThread(thread)}
                    className="rounded-full bg-subtle px-3 py-1.5"
                  >
                    <Text className="text-xs font-t3-bold text-foreground">Fix in a thread</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        })
      )}
      {props.timeline.length > 0 ? (
        <Text className="pt-2 text-xs font-t3-medium uppercase tracking-[0.5px] text-foreground-muted">
          Timeline
        </Text>
      ) : null}
      {props.timeline.slice(0, 12).map((event) => (
        <View key={event.id} className="flex-row items-start gap-2 py-1">
          <Text className="text-xs text-foreground-muted">{relativeTime(event.at)}</Text>
          <Text className="flex-1 text-sm text-foreground">
            {event.actor?.login ?? ""} {event.title}
            {event.body ? ` — ${event.body}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

function FilesTab(props: {
  readonly files: ReadonlyArray<ParsedDiffFile>;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly onLoadMore: () => void;
  readonly onOpenFile: (path: string) => void;
}) {
  const muted = String(useThemeColor("--color-icon-subtle"));
  if (props.loading) {
    return (
      <View className="items-center py-16">
        <ActivityIndicator color={muted} />
      </View>
    );
  }
  if (props.error && props.files.length === 0) {
    return <EmptyState title="Could not load the diff" detail={props.error} />;
  }
  if (props.files.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title="No files in this diff"
        detail="The host did not return a patch for this pull request."
      />
    );
  }
  return (
    <View className="gap-2 pt-2">
      {props.truncated ? (
        <Text className="text-xs text-foreground-muted">
          This slice of the diff is truncated. Open a file to read it.
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-[20px] bg-card">
        {props.files.map((file, index) => {
          const diff = formatDiffStat(file.additions, file.deletions);
          return (
            <Pressable
              key={file.key}
              onPress={() => props.onOpenFile(file.displayPath)}
              className="flex-row items-center gap-3 px-4 py-3 active:opacity-80"
              style={{
                borderBottomWidth: index === props.files.length - 1 ? 0 : 1,
                borderBottomColor: "rgba(127,127,127,0.18)",
              }}
            >
              <SymbolView name="doc.text" size={15} tintColor={muted} type="monochrome" />
              <Text className="flex-1 font-mono text-sm text-foreground" numberOfLines={1}>
                {file.displayPath}
              </Text>
              {diff ? (
                <Text className="font-mono text-2xs tabular-nums text-foreground-tertiary">
                  {diff}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {props.nextCursor !== null ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.loadingMore}
          onPress={props.onLoadMore}
          className="items-center rounded-full bg-subtle px-4 py-3"
        >
          <Text className="text-sm font-t3-bold text-foreground">
            {props.loadingMore ? "Loading more files…" : "Load more files"}
          </Text>
        </Pressable>
      ) : null}
      {props.error ? <Text className="text-xs text-foreground-muted">{props.error}</Text> : null}
    </View>
  );
}
