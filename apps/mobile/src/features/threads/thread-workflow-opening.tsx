import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  resolveWorkflowOpening,
  workflowOpeningHeadline,
  workflowOpeningParentThreadId,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { environmentThreadDetails } from "../../state/threads";
import { SubagentRow } from "./SubagentRow";
import { WorkLogBlock } from "./work-log-layout";

/** The workflow opening for a thread, or null; the parent's detail loads only for a workflow. */
export function useWorkflowOpening(environmentId: EnvironmentId, threadId: ThreadId) {
  const threadAtom = environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, threadId));
  // Selected as a primitive so an ordinary thread's updates never change the result.
  const parentId = useAtomValue(threadAtom, (thread) =>
    thread === null
      ? null
      : workflowOpeningParentThreadId({
          thread: thread.projection.thread,
          messages: thread.projection.messages,
        }),
  );
  const projection = useAtomValue(threadAtom, (thread) =>
    parentId === null ? null : (thread?.projection ?? null),
  );
  const parentSubagents = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, parentId ?? threadId)),
    (parent) => (parentId === null ? null : (parent?.projection.subagents ?? null)),
  );
  return projection === null
    ? null
    : resolveWorkflowOpening({
        thread: projection.thread,
        messages: projection.messages,
        parentSubagents,
      });
}

function memberRowSubagent(
  member: RuntimeSubagent,
  opening: WorkflowOpeningValue,
  coordinatorThreadId: ThreadId,
) {
  return {
    // A member's parent thread is the coordinator's thread, the one showing this opening.
    threadId: coordinatorThreadId,
    childThreadId: member.childThreadId as ThreadId | null,
    model: member.model,
    driver: opening.driver!,
    providerInstanceId: opening.providerInstanceId!,
    title: member.title,
    prompt: member.progress ?? member.title,
    status: member.status,
    progress: undefined,
    result: member.result ?? member.error,
  };
}

type WorkflowOpeningValue = NonNullable<ReturnType<typeof useWorkflowOpening>>;

/** Replaces a workflow coordinator's script message: the plan, then the script on demand. */
export function ThreadWorkflowOpening(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly opening: WorkflowOpeningValue;
}) {
  const navigation = useNavigation();
  const [scriptOpen, setScriptOpen] = useState(false);
  const { opening } = props;
  const headline = workflowOpeningHeadline(opening);
  const canListMembers = opening.driver !== null && opening.providerInstanceId !== null;
  const phases = (opening.group?.phases ?? []).filter((phase) => phase.members.length > 0);
  const unphased = opening.group?.unphasedMembers ?? [];
  const renderMember = (member: RuntimeSubagent) => {
    const threadId = member.childThreadId;
    return (
      <Pressable
        key={member.id}
        accessibilityRole={threadId === null ? undefined : "link"}
        accessibilityHint={threadId === null ? undefined : "Opens this agent's thread"}
        disabled={threadId === null}
        onPress={() => {
          if (threadId !== null)
            navigation.dispatch(
              StackActions.push("Thread", {
                environmentId: String(props.environmentId),
                threadId,
              }),
            );
        }}
        className="rounded-lg px-3 py-3 active:bg-subtle"
      >
        <SubagentRow
          environmentId={props.environmentId}
          subagent={memberRowSubagent(member, opening, props.threadId)}
          elapsed={null}
        />
      </Pressable>
    );
  };
  return (
    <WorkLogBlock>
      <View className="mb-5 gap-2 rounded-xl border border-border bg-card/30 p-3">
        <View className="flex-row items-start gap-2">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-t3-medium text-2xs text-foreground-muted">Workflow started</Text>
            <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
              {headline.title}
            </Text>
            {headline.description ? (
              <Text className="text-xs text-foreground-muted">{headline.description}</Text>
            ) : null}
          </View>
          {headline.agents ? (
            <Text className="shrink-0 text-2xs tabular-nums text-foreground-muted">
              {headline.agents}
            </Text>
          ) : null}
        </View>
        {canListMembers
          ? phases.map((phase) => (
              <View key={phase.index} className="gap-px">
                <Text className="px-1 pt-1 font-t3-medium text-2xs text-foreground-muted">
                  {phase.title} · {phase.settledCount}/{phase.members.length}
                </Text>
                {phase.members.map(renderMember)}
              </View>
            ))
          : null}
        {canListMembers ? unphased.map(renderMember) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: scriptOpen }}
          onPress={() => setScriptOpen((open) => !open)}
          className="flex-row items-center gap-1.5 py-1 active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-foreground-muted">View script</Text>
          <SymbolView
            name={scriptOpen ? "chevron.up" : "chevron.down"}
            size={10}
            tintColorClassName="accent-icon-subtle"
          />
        </Pressable>
        {scriptOpen ? (
          <Text selectable className="font-mono text-2xs text-foreground-muted">
            {opening.script}
          </Text>
        ) : null}
      </View>
    </WorkLogBlock>
  );
}
