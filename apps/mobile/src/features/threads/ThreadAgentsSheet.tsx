import {
  formatSubagentTokenCount,
  isActiveSubagentStatus,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { LegendList } from "@legendapp/list/react-native";
import {
  StackActions,
  useIsFocused,
  useNavigation,
  useRoute,
  type RouteProp,
  type StaticScreenProps,
} from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadDetail } from "../../state/use-thread-detail";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  deriveMobileAgentDetailModel,
  deriveMobileAgentPanelModel,
  deriveMobileAgentRowModel,
  findMobileAgent,
  type MobileAgentDetailModel,
} from "./agentPresentation";
import {
  agentDetailColdStartRosterAction,
  agentDetailUnavailablePresentation,
  agentsColdStartHomeAction,
} from "./threadAgentsNavigation";

type ThreadAgentsSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type ThreadAgentDetailSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly agentId: string;
}>;

type ThreadAgentDetailRoute = RouteProp<
  {
    readonly ThreadAgentDetail: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly agentId: string;
    };
  },
  "ThreadAgentDetail"
>;

function AgentsAndroidColdStartHeader() {
  const navigation = useNavigation();
  return (
    <AndroidHeaderIconButton
      accessibilityLabel="Go to threads list"
      icon="list.bullet"
      onPress={() => navigation.dispatch(StackActions.replace("Home"))}
    />
  );
}

function AgentDetailAndroidColdStartHeader() {
  const navigation = useNavigation();
  const route = useRoute<ThreadAgentDetailRoute>();
  const action = agentDetailColdStartRosterAction({
    canGoBack: false,
    environmentId: route.params.environmentId,
    threadId: route.params.threadId,
    replaceWithRoster: (params) =>
      navigation.dispatch(StackActions.replace("ThreadAgents", params)),
  });
  return (
    <AndroidHeaderIconButton
      accessibilityLabel={action?.accessibilityLabel ?? "Go to Agents roster"}
      icon="person.3"
      onPress={action?.onPress}
    />
  );
}

function useAgentElapsedNow(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [enabled]);
  return nowMs;
}

function useThreadAgents(params: { readonly environmentId: string; readonly threadId: string }) {
  const threadState = useThreadDetail({
    environmentId: EnvironmentId.make(params.environmentId),
    threadId: ThreadId.make(params.threadId),
  });
  const thread = Option.getOrNull(threadState.data);
  const activities = thread?.activities;
  const sessionStatus = thread?.session?.status;
  const sessionLive =
    sessionStatus !== undefined &&
    sessionStatus !== "stopped" &&
    sessionStatus !== "interrupted" &&
    sessionStatus !== "error";
  const model = useMemo(
    () =>
      deriveMobileAgentPanelModel({
        activities: activities ?? [],
        sessionLive,
      }),
    [activities, sessionLive],
  );
  return { model, thread, threadState };
}

function statusDotClass(status: RuntimeSubagent["status"]): string {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "bg-sky-500";
    case "completed":
      return "bg-emerald-500";
    case "failed":
      return "bg-rose-500";
    case "idle":
    case "cancelled":
    case "interrupted":
      return "bg-neutral-400 dark:bg-neutral-500";
  }
}

const AgentStatusDot = memo(function AgentStatusDot(props: {
  readonly status: RuntimeSubagent["status"];
}) {
  return <View className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClass(props.status))} />;
});

const AgentChip = memo(function AgentChip(props: {
  readonly label: string;
  readonly mono?: boolean;
}) {
  return (
    <View className="max-w-40 rounded border border-border px-1.5 py-0.5">
      <Text
        className={cn(
          "text-3xs text-foreground-muted",
          props.mono ? "font-mono" : "font-t3-medium",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </View>
  );
});

const AgentRow = memo(function AgentRow(props: {
  readonly agent: RuntimeSubagent;
  readonly nowMs: number;
  readonly onPress: (agentId: string) => void;
}) {
  const row = deriveMobileAgentRowModel(props.agent, props.nowMs);
  const metrics = [row.tokenLabel, row.toolLabel, row.activationLabel].filter(
    (value): value is string => value !== null,
  );
  return (
    <Pressable
      accessibilityLabel={`${row.title}, ${row.statusLabel}, ${row.activity}, ${metrics.join(", ")}`}
      accessibilityHint="Double tap to open agent details"
      accessibilityRole="button"
      className="min-h-[76px] border-b border-border/60 px-1 py-2.5"
      onPress={() => props.onPress(row.id)}
    >
      <View className="flex-row items-center gap-2">
        <AgentStatusDot status={row.status} />
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground" numberOfLines={1}>
          {row.title}
        </Text>
        {row.elapsed ? (
          <Text className="shrink-0 font-mono text-2xs tabular-nums text-foreground-muted">
            {row.elapsed}
          </Text>
        ) : null}
      </View>
      <Text
        className={cn(
          "ml-3.5 mt-1 text-xs text-foreground-muted",
          row.status === "failed" && "text-rose-600 dark:text-rose-400",
        )}
        numberOfLines={1}
      >
        {row.activity}
      </Text>
      <View className="ml-3.5 mt-1.5 flex-row items-center gap-1.5">
        {row.role ? <AgentChip label={row.role} /> : null}
        {row.modelLabel ? <AgentChip label={row.modelLabel} mono /> : null}
        <Text
          className="min-w-0 flex-1 text-right font-mono text-3xs tabular-nums text-foreground-muted"
          numberOfLines={1}
        >
          {metrics.join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
});

const PhaseHeader = memo(function PhaseHeader(props: {
  readonly phase: AgentPanelWorkflowGroup["phases"][number];
}) {
  const phaseSummary =
    props.phase.state === "pending" && props.phase.members.length === 0
      ? "Pending"
      : props.phase.state === "done"
        ? `${props.phase.settledCount} done`
        : `${props.phase.activeCount} active · ${props.phase.settledCount} done`;
  return (
    <View className="flex-row items-center gap-2 px-1 pb-1 pt-3">
      <Text
        className={cn(
          "min-w-0 flex-1 text-2xs font-t3-bold uppercase tracking-[1px] text-foreground-muted",
          props.phase.state === "running" && "text-sky-600 dark:text-sky-400",
          props.phase.state === "done" && "text-emerald-600 dark:text-emerald-400",
        )}
        numberOfLines={1}
      >
        {props.phase.title}
      </Text>
      <Text className="text-2xs text-foreground-muted">{phaseSummary}</Text>
    </View>
  );
});

const WorkflowHeader = memo(function WorkflowHeader(props: {
  readonly group: AgentPanelWorkflowGroup;
}) {
  const members = [
    ...props.group.phases.flatMap((phase) => phase.members),
    ...props.group.unphasedMembers,
  ];
  const settledCount = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  return (
    <View className="flex-row items-center gap-2 border-b border-border px-1 pb-2 pt-1">
      <AgentStatusDot status={props.group.workflow.status} />
      <Text className="min-w-0 flex-1 font-t3-bold text-sm text-foreground" numberOfLines={1}>
        {props.group.workflow.workflowName ?? props.group.workflow.title}
      </Text>
      <Text className="font-mono text-2xs tabular-nums text-foreground-muted">
        {settledCount}/{members.length} settled
      </Text>
    </View>
  );
});

const AgentsSummary = memo(function AgentsSummary(props: {
  readonly model: ReturnType<typeof deriveMobileAgentPanelModel>;
}) {
  const workingCount = props.model.runningCount + props.model.waitingCount;
  const parts = [
    workingCount > 0 ? `${workingCount} working` : null,
    props.model.idleCount > 0 ? `${props.model.idleCount} idle` : null,
    props.model.settledCount > 0 ? `${props.model.settledCount} settled` : null,
  ].filter((value): value is string => value !== null);
  return (
    <View className="flex-row items-center justify-between border-t border-border px-1 pb-1 pt-3">
      <Text className="text-xs text-foreground-muted">{parts.join(" · ")}</Text>
      <Text className="font-mono text-xs tabular-nums text-foreground-muted">
        Σ {formatSubagentTokenCount(props.model.totalTokens)} tok
      </Text>
    </View>
  );
});

type AgentsListItem =
  | {
      readonly kind: "workflow-header";
      readonly key: string;
      readonly group: AgentPanelWorkflowGroup;
    }
  | {
      readonly kind: "phase-header";
      readonly key: string;
      readonly phase: AgentPanelWorkflowGroup["phases"][number];
    }
  | { readonly kind: "section-header"; readonly key: string; readonly title: string }
  | { readonly kind: "agent"; readonly key: string; readonly agent: RuntimeSubagent }
  | { readonly kind: "spacer"; readonly key: string }
  | {
      readonly kind: "summary";
      readonly key: string;
      readonly model: ReturnType<typeof deriveMobileAgentPanelModel>;
    };

function buildAgentsListItems(
  model: ReturnType<typeof deriveMobileAgentPanelModel>,
): ReadonlyArray<AgentsListItem> {
  const items: AgentsListItem[] = [];
  for (const group of model.workflows) {
    const workflowId = group.workflow.id;
    items.push({ kind: "workflow-header", key: `workflow:${workflowId}`, group });
    for (const phase of group.phases) {
      items.push({
        kind: "phase-header",
        key: `workflow:${workflowId}:phase:${phase.index}`,
        phase,
      });
      for (const member of phase.members) {
        items.push({ kind: "agent", key: `agent:${member.id}`, agent: member });
      }
    }
    if (group.unphasedMembers.length > 0) {
      items.push({
        kind: "section-header",
        key: `workflow:${workflowId}:other`,
        title: "Other agents",
      });
      for (const member of group.unphasedMembers) {
        items.push({ kind: "agent", key: `agent:${member.id}`, agent: member });
      }
    }
    if (group.phases.length === 0 && group.unphasedMembers.length === 0) {
      items.push({
        kind: "agent",
        key: `agent:${group.workflow.id}`,
        agent: group.workflow,
      });
    }
    items.push({ kind: "spacer", key: `workflow:${workflowId}:spacer` });
  }
  if (model.directAgents.length > 0) {
    items.push({ kind: "section-header", key: "direct-header", title: "Direct spawns" });
    for (const agent of model.directAgents) {
      items.push({ kind: "agent", key: `agent:${agent.id}`, agent });
    }
    items.push({ kind: "spacer", key: "direct-spacer" });
  }
  items.push({ kind: "summary", key: "summary", model });
  return items;
}

export function ThreadAgentsSheet(props: ThreadAgentsSheetProps) {
  const navigation = useNavigation();
  const canGoBack = navigation.canGoBack();
  const homeAction = useMemo(
    () =>
      agentsColdStartHomeAction({
        canGoBack,
        replaceWithHome: () => navigation.dispatch(StackActions.replace("Home")),
      }),
    [canGoBack, navigation],
  );
  const homeHeaderItems = useMemo(
    () =>
      homeAction
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: homeAction.accessibilityLabel,
              icon: { name: "list.bullet", type: "sfSymbol" as const },
              identifier: "agents-left-home",
              onPress: homeAction.onPress,
              type: "button" as const,
            }),
          ]
        : [],
    [homeAction],
  );
  const { model, thread, threadState } = useThreadAgents(props.route.params);
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const listItems = useMemo(() => buildAgentsListItems(model), [model]);
  const nowMs = useAgentElapsedNow(isFocused && model.liveCount > 0);
  const handleOpenAgent = useCallback(
    (agentId: string) => {
      navigation.navigate("ThreadAgentDetail", {
        environmentId: props.route.params.environmentId,
        threadId: props.route.params.threadId,
        agentId,
      });
    },
    [navigation, props.route.params.environmentId, props.route.params.threadId],
  );
  const isLoading =
    thread === null && (threadState.status === "empty" || threadState.status === "synchronizing");
  const renderItem = useCallback(
    ({ item }: { readonly item: AgentsListItem }) => {
      switch (item.kind) {
        case "workflow-header":
          return <WorkflowHeader group={item.group} />;
        case "phase-header":
          return <PhaseHeader phase={item.phase} />;
        case "section-header":
          return (
            <Text className="px-1 pb-1 pt-1 text-2xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
              {item.title}
            </Text>
          );
        case "agent":
          return <AgentRow agent={item.agent} nowMs={nowMs} onPress={handleOpenAgent} />;
        case "spacer":
          return <View className="h-3" />;
        case "summary":
          return <AgentsSummary model={item.model} />;
      }
    },
    [handleOpenAgent, nowMs],
  );
  const headerOptions = (
    <NativeStackScreenOptions
      options={{
        headerBackVisible: canGoBack,
        unstable_headerLeftItems:
          Platform.OS === "ios" && homeAction ? () => homeHeaderItems : undefined,
        headerLeft:
          Platform.OS === "android" && homeAction ? AgentsAndroidColdStartHeader : undefined,
      }}
    />
  );

  if (isLoading) {
    return (
      <>
        {headerOptions}
        <View className="flex-1 items-center justify-center gap-3 bg-screen px-6">
          <Text className="text-sm text-foreground-muted">Loading agents…</Text>
        </View>
      </>
    );
  }

  if (!model.hasAgents) {
    return (
      <>
        {headerOptions}
        <View className="flex-1 items-center justify-center bg-screen px-6">
          <EmptyState
            variant="plain"
            title="No agents yet"
            detail="Subagents and workflow runs will appear here with status, activity, and usage."
          />
        </View>
      </>
    );
  }

  return (
    <>
      {headerOptions}
      <LegendList
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        data={listItems}
        drawDistance={500}
        estimatedItemSize={76}
        extraData={nowMs}
        getItemType={(item) => item.kind}
        keyExtractor={(item) => item.key}
        recycleItems
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
      />
    </>
  );
}

function AgentDetailOverview(props: { readonly model: MobileAgentDetailModel }) {
  return (
    <View className="mb-2 border-b border-border pb-4 pt-1">
      <View className="flex-row items-center gap-2">
        <AgentStatusDot status={props.model.status} />
        <Text className="min-w-0 flex-1 font-t3-bold text-lg text-foreground" numberOfLines={2}>
          {props.model.title}
        </Text>
        {props.model.elapsed ? (
          <Text className="font-mono text-xs tabular-nums text-foreground-muted">
            {props.model.elapsed}
          </Text>
        ) : null}
      </View>
      <Text
        className={cn(
          "ml-3.5 mt-2 text-sm text-foreground-muted",
          props.model.status === "failed" && "text-rose-600 dark:text-rose-400",
        )}
      >
        {props.model.activity}
      </Text>
    </View>
  );
}

function formatActivityTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function ThreadAgentDetailSheet(props: ThreadAgentDetailSheetProps) {
  const navigation = useNavigation();
  const canGoBack = navigation.canGoBack();
  const rosterAction = useMemo(
    () =>
      agentDetailColdStartRosterAction({
        canGoBack,
        environmentId: props.route.params.environmentId,
        threadId: props.route.params.threadId,
        replaceWithRoster: (params) =>
          navigation.dispatch(StackActions.replace("ThreadAgents", params)),
      }),
    [canGoBack, navigation, props.route.params.environmentId, props.route.params.threadId],
  );
  const rosterHeaderItems = useMemo(
    () =>
      rosterAction
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: rosterAction.accessibilityLabel,
              icon: { name: "person.3", type: "sfSymbol" as const },
              identifier: "agent-detail-left-roster",
              onPress: rosterAction.onPress,
              type: "button" as const,
            }),
          ]
        : [],
    [rosterAction],
  );
  const { model, thread, threadState } = useThreadAgents(props.route.params);
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const agent = useMemo(
    () => findMobileAgent(model, props.route.params.agentId),
    [model, props.route.params.agentId],
  );
  const nowMs = useAgentElapsedNow(
    isFocused && agent !== null && isActiveSubagentStatus(agent.status),
  );
  const detail = useMemo(
    () => (agent ? deriveMobileAgentDetailModel(agent, nowMs) : null),
    [agent, nowMs],
  );
  const hasOlderTurns = threadHasOlderTurns(threadState);
  const loadingOlder = Option.match(threadState.page, {
    onNone: () => false,
    onSome: (page) => page.loadingOlder,
  });
  const unavailable = agentDetailUnavailablePresentation({ hasOlderTurns, loadingOlder });
  const handleLoadEarlier = useCallback(() => {
    if (loadingOlder) {
      return;
    }
    requestOlderThreadTurns(
      EnvironmentId.make(props.route.params.environmentId),
      ThreadId.make(props.route.params.threadId),
    );
  }, [loadingOlder, props.route.params.environmentId, props.route.params.threadId]);
  const headerOptions = (
    <NativeStackScreenOptions
      options={{
        title: detail?.title ?? "Agent",
        headerBackVisible: canGoBack,
        unstable_headerLeftItems:
          Platform.OS === "ios" && rosterAction ? () => rosterHeaderItems : undefined,
        headerLeft:
          Platform.OS === "android" && rosterAction ? AgentDetailAndroidColdStartHeader : undefined,
      }}
    />
  );
  const isLoading =
    thread === null && (threadState.status === "empty" || threadState.status === "synchronizing");
  if (isLoading) {
    return (
      <>
        {headerOptions}
        <View className="flex-1 items-center justify-center gap-3 bg-screen px-6">
          <Text className="text-sm text-foreground-muted">Loading agent…</Text>
        </View>
      </>
    );
  }

  if (detail === null) {
    return (
      <>
        {headerOptions}
        <View className="flex-1 items-center justify-center bg-screen px-6">
          <EmptyState
            variant="plain"
            title={unavailable.title}
            detail={unavailable.detail}
            actionLabel={unavailable.loadEarlierLabel ?? undefined}
            onAction={unavailable.loadEarlierLabel === null ? undefined : handleLoadEarlier}
          />
        </View>
      </>
    );
  }

  const facts = [
    ["Status", detail.statusLabel],
    ["Role", detail.role ?? "—"],
    ["Model", detail.modelLabel ?? "—"],
    ["Elapsed", detail.elapsed ?? "—"],
    ["Tokens", detail.tokenLabel],
    ["Tools", detail.toolLabel ?? "—"],
  ] as const;
  const narratives = [
    detail.result ? { key: "result", label: "Result", value: detail.result } : null,
    detail.error ? { key: "error", label: "Error", value: detail.error } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <>
      {headerOptions}
      <ScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        showsVerticalScrollIndicator={false}
      >
        <AgentDetailOverview model={detail} />
        {facts.map(([label, value]) => (
          <View
            className="min-h-10 flex-row items-center gap-4 border-b border-border/50 py-2"
            key={label}
          >
            <Text className="w-20 text-xs text-foreground-muted">{label}</Text>
            <Text
              className="min-w-0 flex-1 text-right font-mono text-xs text-foreground"
              selectable
            >
              {value}
            </Text>
          </View>
        ))}
        {narratives.map((item) => (
          <View className="mt-3 rounded-lg border border-border bg-card px-3 py-3" key={item.key}>
            <Text className="text-2xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
              {item.label}
            </Text>
            <Text
              className={cn(
                "mt-1.5 text-sm leading-5 text-foreground",
                item.key === "error" && "text-rose-600 dark:text-rose-400",
              )}
              selectable
            >
              {item.value}
            </Text>
          </View>
        ))}
        <Text className="pb-2 pt-5 text-2xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
          Activity
        </Text>
        {detail.activities.length === 0 ? (
          <Text className="py-3 text-xs text-foreground-muted">No retained activity entries.</Text>
        ) : (
          detail.activities.map((activity) => (
            <View className="flex-row gap-3 border-b border-border/50 py-2.5" key={activity.id}>
              <Text className="w-20 shrink-0 font-mono text-3xs tabular-nums text-foreground-muted">
                {formatActivityTime(activity.at)}
              </Text>
              <Text className="min-w-0 flex-1 text-sm text-foreground" selectable>
                {activity.summary}
              </Text>
            </View>
          ))
        )}
        {detail.activityTruncationLabel ? (
          <Text className="py-3 text-xs text-foreground-muted">
            {detail.activityTruncationLabel}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}
