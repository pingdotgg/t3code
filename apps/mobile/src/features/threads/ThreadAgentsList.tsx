import { useAtomValue } from "@effect/atom-react";
import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { StackActions, useNavigation } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { T, useGT, useMessages } from "gt-react-native";
import { useMemo } from "react";
import { Keyboard, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { environmentThreadDetails } from "../../state/threads";
import { SUBAGENT_TONE_TEXT_CLASS } from "./SubagentStatusDot";
import { SubagentProviderIcon } from "./SubagentRow";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { SubagentStopButton } from "./SubagentStopButton";
import { ThreadWorkflowGroup } from "./ThreadWorkflowGroup";
import {
  resolveSubagentRowPresentation,
  subagentThreadTarget,
  type SubagentThreadTarget,
} from "./threadAgentsPresentation";
import { subagentCardDetail } from "@t3tools/client-runtime/state/subagent-display";
import { cn } from "../../lib/cn";
import { useLinkedThreadReach } from "../../state/linkedThread";

import { useOpenThreadInspector } from "./thread-inspector-navigation";
import { useOpenLinkedThreadRead } from "./useOpenLinkedThread";

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const EMPTY_TURN_SUBAGENTS_ATOM = Atom.make<ThreadTurnSubagents | null>(null).pipe(
  Atom.withLabel("mobile-thread-turn-subagents:empty"),
);

export function useThreadTurnSubagents(target: AgentsTarget | null): ThreadTurnSubagents | null {
  return useAtomValue(
    target === null
      ? EMPTY_TURN_SUBAGENTS_ATOM
      : environmentThreadDetails.turnSubagentsAtom(target),
  );
}

/** This turn's agents, listed inside the thread's expanded status card. */
export function ThreadAgentsList(props: {
  readonly target: AgentsTarget;
  readonly turn: ThreadTurnSubagents | null;
  /** Called before a child thread opens, so the card can close first. */
  readonly onOpenChild: () => void;
}) {
  const { target, turn } = props;
  const navigation = useNavigation();
  const openInspector = useOpenThreadInspector();
  const openLinkedRead = useOpenLinkedThreadRead();
  const messages = useMessages();
  const subagents = turn?.subagents ?? [];
  const hasLiveAgent = (turn?.liveCount ?? 0) > 0;
  const workflowGroups = useMemo(
    () =>
      new Map(
        deriveWorkflowGroups(projectedSubagentsToRuntime(subagents), messages).map((group) => [
          group.workflow.id,
          group,
        ]),
      ),
    [messages, subagents],
  );

  const openChildThread = (child: SubagentThreadTarget, title: string | null = null) => {
    void Haptics.selectionAsync();
    Keyboard.dismiss();
    props.onOpenChild();
    if (child.linked !== undefined) {
      openLinkedRead(child, child.linked, title, { source: target });
      return;
    }
    if (
      openInspector(target, {
        type: "thread",
        environmentId: child.environmentId,
        threadId: child.threadId,
      })
    )
      return;
    navigation.dispatch(
      StackActions.push("Thread", {
        environmentId: child.environmentId,
        threadId: child.threadId,
      }),
    );
  };

  if (subagents.length === 0) {
    return (
      <Text className="py-4 text-center text-sm text-foreground-muted">
        <T>No agents in this turn.</T>
      </Text>
    );
  }
  return (
    <View>
      {subagents.map((subagent, index) => {
        const group = workflowGroups.get(subagent.id);
        return group === undefined ? (
          <View key={subagent.id} className={index === 0 ? undefined : "border-t border-border"}>
            <AgentRow
              subagent={subagent}
              environmentId={target.environmentId}
              tickSeconds={hasLiveAgent}
              onOpen={openChildThread}
            />
          </View>
        ) : (
          <ThreadWorkflowGroup
            key={subagent.id}
            environmentId={target.environmentId}
            subagent={subagent}
            group={group}
            onOpen={(threadId) =>
              openChildThread({ environmentId: target.environmentId, threadId })
            }
          />
        );
      })}
    </View>
  );
}

function AgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly onOpen: (child: SubagentThreadTarget, title: string | null) => void;
}) {
  const { subagent } = props;
  const gt = useGT();
  const reach = useLinkedThreadReach(props.environmentId, [subagent]);
  const target = subagentThreadTarget(
    subagent,
    props.environmentId,
    reach.ownConnection,
    reach.isLinked,
  );

  const messages = useMessages();
  const presentation = resolveSubagentRowPresentation(subagent, target !== null, messages);
  const cardDetail = subagentCardDetail(presentation.detail);
  // A task without progress reports its own title as its detail.
  const detail = cardDetail === presentation.title ? null : cardDetail;
  const row = (
    <View className="min-h-14 flex-row items-center gap-3 py-2.5">
      <SubagentProviderIcon environmentId={props.environmentId} subagent={subagent} size={18} />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="min-w-0 shrink font-t3-medium text-sm text-foreground">
            {presentation.title}
          </Text>
          <AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} />
        </View>
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          <Text className={cn("font-t3-medium", SUBAGENT_TONE_TEXT_CLASS[presentation.tone])}>
            {presentation.statusLabel}
          </Text>
          {detail ? ` · ${detail}` : ""}
        </Text>
      </View>
    </View>
  );

  const content =
    target === null ? (
      <View
        accessible
        className="min-w-0 flex-1"
        accessibilityHint={gt("Provider-managed agent. Its work appears in the transcript.")}
      >
        {row}
      </View>
    ) : (
      <Pressable
        accessibilityRole="link"
        accessibilityHint={
          target.linked === undefined
            ? gt("Opens this agent's thread")
            : gt("Opens a read-only view of this agent's thread on {label}", {
                label: target.linked.label,
              })
        }
        onPress={() => props.onOpen(target, subagent.title)}
        className="min-w-0 flex-1 active:opacity-70"
      >
        {row}
      </Pressable>
    );

  return (
    <View className="flex-row items-center gap-2">
      {content}
      <SubagentStopButton environmentId={props.environmentId} subagent={subagent} compact />
    </View>
  );
}

function AgentElapsed(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
}) {
  const elapsed = useSubagentElapsed(props.subagent, props.tickSeconds);
  return elapsed === null ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  );
}

function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const running = isOrchestrationV2WorkActive(subagent.status);
  const nowMs = useVisibleSecondClock(tickSeconds && running);
  const messages = useMessages();
  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: subagent.status,
      startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    },
    nowMs,
  );
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs, messages);
}
