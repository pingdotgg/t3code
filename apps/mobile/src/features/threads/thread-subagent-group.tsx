import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import { summarizeSubagentStatuses } from "@t3tools/client-runtime/state/subagent-display";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ServerConfig,
} from "@t3tools/contracts";
import { Pressable, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { subagentCardElapsed } from "./subagent-card-presentation";
import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { SubagentRow } from "./SubagentRow";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { subagentThreadTarget } from "./threadAgentsPresentation";
import { WorkLogBlock } from "./work-log-layout";

import { useOpenThreadInspector } from "./thread-inspector-navigation";

type SubagentItem = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
type AgentTiming = Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">;

function SubagentElapsed({ agents }: { readonly agents: ReadonlyArray<AgentTiming> }) {
  const live = agents.some((agent) => isActiveSubagentStatus(agent.status));
  const nowMs = useVisibleSecondClock(live);
  const elapsed = subagentCardElapsed(agents, nowMs);
  return elapsed ? (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  ) : null;
}

function SubagentAvatar(props: {
  readonly item: SubagentItem;
  readonly config: ServerConfig | null | undefined;
}) {
  const providers = props.config?.providers ?? [];
  const provider = providers.find(
    (candidate) => candidate.instanceId === props.item.providerInstanceId,
  );
  // A remote task's own driver is only a "remote" label.
  const driver =
    provider?.driver ?? (props.item.remoteChild === undefined ? props.item.driver : undefined);
  const badgeEntries = providers.map((candidate) => {
    const rawConfig = props.config?.settings.providerInstances[candidate.instanceId]?.config;
    const instanceConfig =
      rawConfig !== null && typeof rawConfig === "object"
        ? (rawConfig as Readonly<Record<string, unknown>>)
        : null;
    const agentId = instanceConfig?.source === "local" ? undefined : instanceConfig?.agentId;
    return {
      ...candidate,
      driverKind: candidate.driver,
      acpRegistryAgentId: typeof agentId === "string" ? agentId.trim() || undefined : undefined,
    };
  });
  const badgeEntry = badgeEntries.find(
    (candidate) => candidate.instanceId === props.item.providerInstanceId,
  );
  const showBadge =
    provider !== undefined &&
    badgeEntry !== undefined &&
    shouldShowInstanceBadge(badgeEntry, badgeEntries);
  return (
    <View
      accessible={false}
      className="h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card"
    >
      {showBadge ? (
        <ProviderInstanceIcon
          provider={provider.driver}
          iconUrl={provider.iconUrl}
          size={15}
          displayName={resolveProviderInstanceDisplayName(provider)}
          accentColor={provider.accentColor}
          showBadge
        />
      ) : driver === undefined ? (
        <SymbolView name="sparkles" size={13} tintColorClassName="accent-icon-muted" />
      ) : (
        <ProviderIcon provider={driver} iconUrl={provider?.iconUrl} size={15} />
      )}
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
  const openInspector = useOpenThreadInspector();
  const members = props.activities.flatMap(({ projectedItem }) =>
    projectedItem.item.type === "subagent" ? [projectedItem.item] : [],
  );
  const liveAgents = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, members[0]!.threadId)),
    (thread) => thread?.projection.subagents,
  );
  const { presentationById } = useEnvironments();
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
  const serverConfigs = useServerConfigs();
  // A task in a linked environment runs a provider instance of that environment.
  const configOf = (item: SubagentItem) =>
    item.remoteChild === undefined ? config : serverConfigs.get(item.remoteChild.environmentId);
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
                <SubagentAvatar item={agent.item} config={configOf(agent.item)} />
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
            // A task in a linked environment opens there, if this app is connected to it.
            const target = subagentThreadTarget(agent, props.environmentId, (id) =>
              presentationById.has(id),
            );
            return (
              <Pressable
                key={agent.item.id}
                accessible
                accessibilityRole={target === null ? undefined : "link"}
                accessibilityHint={
                  target !== null
                    ? "Opens this agent's thread"
                    : agent.remoteChild !== undefined
                      ? `Runs on ${agent.remoteChild.label}`
                      : "Provider-managed agent"
                }
                disabled={target === null}
                onPress={() => {
                  if (target === null) return;
                  if (
                    openInspector(
                      { environmentId: props.environmentId, threadId: members[0]!.threadId },
                      {
                        type: "thread",
                        environmentId: target.environmentId,
                        threadId: target.threadId,
                      },
                    )
                  )
                    return;
                  navigation.dispatch(
                    StackActions.push("Thread", {
                      environmentId: String(target.environmentId),
                      threadId: String(target.threadId),
                    }),
                  );
                }}
                className="rounded-lg px-3 py-3 active:bg-subtle"
              >
                <SubagentRow
                  environmentId={props.environmentId}
                  subagent={agent}
                  canOpenRemote={target !== null}
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
