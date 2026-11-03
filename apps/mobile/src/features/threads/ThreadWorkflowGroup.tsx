import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isActiveSubagentStatus,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ServerProvider,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Chip } from "../../components/ui/Chip";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import { SubagentStopButton } from "./SubagentStopButton";
import {
  nextWorkflowSelection,
  resolveSubagentRowPresentation,
  workflowMemberDetail,
  workflowMemberMetadata,
  workflowRail,
  type WorkflowRailTone,
} from "./threadAgentsPresentation";
import { useVisibleSecondClock } from "./use-visible-second-clock";

const RAIL_ICON = {
  working: "circle.inset.filled",
  completed: "checkmark.circle.fill",
  failed: "xmark.circle.fill",
  stopped: "circle",
  queued: "circle.dashed",
} as const satisfies Record<WorkflowRailTone, AppSymbolName>;

export function ThreadWorkflowGroup(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly group: SubagentWorkflowGroup;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { group } = props;
  const provider = useEnvironmentServerConfig(props.environmentId)?.providers.find(
    (candidate) => candidate.instanceId === props.subagent.providerInstanceId,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const rail = workflowRail(group);
  const open = rail.find((item) => item.key === selected);
  const label = group.workflow.workflowName ?? group.workflow.title;
  const statusLabel = resolveSubagentRowPresentation(props.subagent).statusLabel;

  return (
    <View className="my-2">
      <ListSection>
        <View className="flex-row items-center">
          <RowPressable
            accessibilityRole="button"
            accessibilityLabel={`${label} workflow, ${statusLabel}`}
            accessibilityHint={open ? "Collapses the workflow" : "Opens the current phase"}
            accessibilityState={{ expanded: open !== undefined }}
            disabled={rail.length === 0}
            onPress={() => setSelected(nextWorkflowSelection(rail, selected))}
            className="min-w-0 flex-1 active:opacity-70"
          >
            <WorkflowHeaderLayout
              label={label}
              statusLabel={statusLabel}
              timing={group.workflow}
              accessory={
                rail.length > 0 ? (
                  <SymbolView
                    name={open ? "chevron.up" : "chevron.down"}
                    size={12}
                    tintColorClassName="accent-icon-subtle"
                  />
                ) : null
              }
            />
          </RowPressable>
          <SubagentStopButton
            environmentId={props.environmentId}
            subagent={props.subagent}
            className="mr-2"
          />
        </View>
        {rail.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 px-4 pb-3"
          >
            {rail.map((item) => {
              const count =
                item.tone === "working" || item.tone === "failed"
                  ? `${item.completedCount}/${item.members.length}`
                  : null;
              return (
                <Chip
                  key={item.key}
                  icon={RAIL_ICON[item.tone]}
                  label={count ? `${count} ${item.title}` : item.title}
                  selected={item.key === selected}
                  accessibilityLabel={`${item.title} phase, ${item.tone}${count ? `, ${count} completed` : ""}`}
                  onPress={() => setSelected(nextWorkflowSelection(rail, selected, item.key))}
                />
              );
            })}
          </ScrollView>
        ) : null}
        {open === undefined ? null : open.members.length === 0 ? (
          <Text
            textRole="footnote"
            className="border-t border-border-subtle px-4 py-3 text-foreground-muted"
          >
            No agents yet
          </Text>
        ) : (
          open.members.map((member) => (
            <WorkflowMemberRow
              key={member.id}
              environmentId={props.environmentId}
              member={member}
              provider={provider}
              onOpen={props.onOpen}
            />
          ))
        )}
      </ListSection>
    </View>
  );
}

function WorkflowMemberRow(props: {
  readonly environmentId: EnvironmentId;
  readonly member: RuntimeSubagent;
  readonly provider: ServerProvider | undefined;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { member } = props;
  const threadId = member.childThreadId === null ? null : ThreadId.make(member.childThreadId);
  const shell = useThreadShell(
    threadId === null ? null : scopeThreadRef(props.environmentId, threadId),
  );
  const canOpen = threadId !== null && shell !== null;
  const presentation = resolveSubagentRowPresentation({
    title: member.title,
    prompt: "",
    status: member.status,
    result: null,
    childThreadId: threadId,
  });
  const { detail, error } = workflowMemberDetail(member);
  const metadata = workflowMemberMetadata(member, props.provider);
  const labels = [metadata.model, metadata.effort].filter((value) => value !== null);
  return (
    <RowPressable
      accessibilityRole={canOpen ? "link" : undefined}
      accessibilityLabel={[
        presentation.title,
        presentation.statusLabel,
        ...labels,
        ...(metadata.speed === null ? [] : [metadata.speed]),
        ...(error === null ? [] : [error]),
      ].join(", ")}
      accessibilityHint={canOpen ? "Opens this agent's thread" : "Its thread is not available yet"}
      disabled={!canOpen}
      onPress={() => threadId !== null && props.onOpen(threadId)}
      className="min-h-11 flex-row gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
    >
      <View className="h-5 justify-center">
        <SubagentStatusDot tone={presentation.tone} placement="sheet" />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="min-h-5 flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-baseline gap-1.5">
            <Text
              textRole="footnote"
              numberOfLines={1}
              className="min-w-0 shrink font-t3-medium text-foreground"
            >
              {presentation.title}
            </Text>
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              textRole="label"
              className="shrink-0 text-foreground-muted"
            >
              ·
            </Text>
            <Text
              textRole="label"
              className={cn("shrink-0 font-t3-medium", SUBAGENT_TONE_TEXT_CLASS[presentation.tone])}
            >
              {presentation.statusLabel}
            </Text>
          </View>
          <WorkflowElapsed timing={member} />
          {canOpen ? (
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
          ) : null}
        </View>
        {labels.length > 0 || metadata.speed !== null ? (
          <View className="min-w-0 flex-row items-center">
            <Text
              textRole="label"
              numberOfLines={1}
              className="min-w-0 shrink text-foreground-muted"
            >
              {labels.join(" · ")}
              {labels.length > 0 && metadata.speed !== null ? " · " : ""}
            </Text>
            {metadata.fast ? (
              <View className="shrink-0 flex-row items-center gap-0.5">
                <SymbolView
                  name={{ ios: "bolt.fill", android: "bolt" }}
                  size={11}
                  tintColorClassName="accent-adaptive-amber-700-300"
                />
                <Text textRole="label" className="text-adaptive-amber-700-300">
                  {metadata.speed}
                </Text>
              </View>
            ) : metadata.speed !== null ? (
              <Text textRole="label" className="shrink-0 text-foreground-muted">
                {metadata.speed}
              </Text>
            ) : null}
          </View>
        ) : null}
        {detail ? (
          <Text textRole="label" numberOfLines={1} className="text-foreground-muted">
            {detail}
          </Text>
        ) : null}
        {error ? (
          <Text textRole="label" numberOfLines={1} className={SUBAGENT_TONE_TEXT_CLASS.failed}>
            {error}
          </Text>
        ) : null}
      </View>
    </RowPressable>
  );
}

function WorkflowHeaderLayout(props: {
  readonly label: string;
  readonly statusLabel: string;
  readonly timing: ElapsedTiming;
  readonly accessory: ReactNode;
}) {
  const elapsed = useElapsedLabel(props.timing);
  return (
    <ListRowLayout
      icon="point.3.connected.trianglepath.dotted"
      label={props.label}
      description={props.statusLabel}
      detail={elapsed ?? undefined}
      accessory={props.accessory}
    />
  );
}

function WorkflowElapsed(props: { readonly timing: ElapsedTiming }) {
  const elapsed = useElapsedLabel(props.timing);
  return elapsed === null ? null : (
    <Text textRole="label" className="shrink-0 tabular-nums text-foreground-muted">
      {elapsed}
    </Text>
  );
}

type ElapsedTiming = Parameters<typeof deriveSubagentElapsedMs>[0];

function useElapsedLabel(timing: ElapsedTiming): string | null {
  const nowMs = useVisibleSecondClock(isActiveSubagentStatus(timing.status));
  const elapsedMs = deriveSubagentElapsedMs(timing, nowMs);
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs);
}
