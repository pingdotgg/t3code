import { useAtomValue } from "@effect/atom-react";
import { StackActions, useIsFocused, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { summarizeSubagentStatuses } from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { AppState, Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon, type ProviderGlyphAppearance } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { subagentCardElapsed } from "./subagent-card-presentation";
import { SubagentRow } from "./SubagentRow";
import { WorkLogBlock } from "./work-log-layout";

type SubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
type AgentTiming = Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">;

function SubagentElapsed({ agents }: { readonly agents: ReadonlyArray<AgentTiming> }) {
  const focused = useIsFocused();
  const live = agents.some((agent) => isActiveSubagentStatus(agent.status));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!live || !focused || !appActive) return;
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [appActive, focused, live]);
  const elapsed = subagentCardElapsed(agents, nowMs);
  return elapsed ? (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  ) : null;
}

function SubagentAvatar(props: {
  readonly item: SubagentItem;
  readonly provider: (ProviderGlyphAppearance & { readonly iconUrl?: string }) | undefined;
}) {
  return (
    <View
      accessible={false}
      className="h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card"
    >
      <ProviderIcon
        provider={props.item.driver}
        iconUrl={props.provider?.iconUrl}
        appearance={props.provider}
        size={15}
      />
    </View>
  );
}

export function ThreadSubagentGroup(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly environmentId: EnvironmentId;
  readonly anchorKey: string;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: ColorValue;
  readonly onToggleRow: (rowId: string, anchorKey: string) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const navigation = useNavigation();
  const members = props.activities.flatMap(({ projectedItem }) =>
    projectedItem.item.type === "subagent" ? [projectedItem.item] : [],
  );
  const liveAgents = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, members[0]!.threadId)),
    (thread) => thread?.projection.subagents,
  );
  const agents = members.map((item) => {
    const live = liveAgents?.find((agent) => agent.id === item.subagentId);
    return {
      ...item,
      item,
      status: live?.status ?? item.status,
      startedAt: live?.startedAt ?? item.startedAt,
      completedAt: live?.completedAt ?? item.completedAt,
      result: live?.result ?? item.result,
      progress: live?.progress ?? item.progress,
      model: live?.model ?? null,
    };
  });
  const grouped = agents.length > 1;
  const label = `${agents.length} subagents`;
  const summary = summarizeSubagentStatuses(agents.map((agent) => agent.status));
  const expanded = props.expandedRows[props.anchorKey] ?? false;
  const providerFor = (item: SubagentItem) =>
    config?.providers.find((provider) => provider.instanceId === item.providerInstanceId);
  return (
    <WorkLogBlock>
      {grouped ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${summary}`}
          accessibilityState={{ expanded }}
          onPress={() => props.onToggleRow(props.anchorKey, props.anchorKey)}
          className="min-h-14 flex-row items-center gap-3 rounded-lg py-2 active:bg-subtle"
        >
          <View className="flex-row items-center">
            {agents.slice(0, 3).map((agent, index) => (
              <View key={agent.item.id} style={{ marginLeft: index === 0 ? 0 : -7 }}>
                <SubagentAvatar item={agent.item} provider={providerFor(agent.item)} />
              </View>
            ))}
            {agents.length > 3 ? (
              <View className="-ml-2 h-7 w-7 items-center justify-center rounded-full border border-border bg-card">
                <Text className="text-2xs text-foreground-muted">+{agents.length - 3}</Text>
              </View>
            ) : null}
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
              {label}
            </Text>
            <Text
              numberOfLines={1}
              className={cn(
                "text-2xs text-foreground-muted",
                agents.some((agent) => isActiveSubagentStatus(agent.status))
                  ? "text-adaptive-sky-600-400"
                  : agents.some((agent) => agent.status === "failed") &&
                      "text-adaptive-rose-600-400",
              )}
            >
              {summary}
            </Text>
          </View>
          <SubagentElapsed agents={agents} />
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={11}
            tintColor={props.iconSubtleColor}
          />
        </Pressable>
      ) : null}
      {!grouped || expanded ? (
        <View className="mb-1 gap-px rounded-xl border border-border bg-card/30 p-1">
          {agents.map((agent) => {
            const threadId = agent.childThreadId;
            return (
              <Pressable
                key={agent.item.id}
                accessible
                accessibilityRole={threadId === null ? undefined : "link"}
                accessibilityHint={
                  threadId === null ? "Provider-managed agent" : "Opens this agent's thread"
                }
                disabled={threadId === null}
                onPress={() => {
                  // Push, not navigate: navigate reuses this Thread route, so back
                  // would skip the parent thread.
                  if (threadId !== null)
                    navigation.dispatch(
                      StackActions.push("Thread", {
                        environmentId: String(props.environmentId),
                        threadId: String(threadId),
                      }),
                    );
                }}
                className="rounded-lg px-3 py-3 active:bg-subtle"
              >
                <SubagentRow
                  environmentId={props.environmentId}
                  subagent={agent}
                  elapsed={<SubagentElapsed agents={[agent]} />}
                />
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </WorkLogBlock>
  );
}
