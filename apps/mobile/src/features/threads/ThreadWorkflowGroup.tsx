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
import { Fragment, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
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
  working: { name: "circle.inset.filled", tint: "accent-adaptive-sky-600-400" },
  completed: { name: "checkmark.circle.fill", tint: "accent-adaptive-emerald-600-400" },
  failed: { name: "xmark.circle.fill", tint: "accent-adaptive-rose-600-400" },
  stopped: { name: "circle", tint: "accent-icon-subtle" },
  queued: { name: "circle.dashed", tint: "accent-icon-subtle" },
} as const satisfies Record<WorkflowRailTone, { name: AppSymbolName; tint: string }>;

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
  const tone = resolveSubagentRowPresentation(props.subagent).tone;

  return (
    <View className="my-2 rounded-[20px] border border-border border-continuous bg-card px-3 pb-1">
      <View className="flex-row items-center gap-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} workflow`}
          accessibilityHint={open ? "Collapses the workflow" : "Opens the current phase"}
          accessibilityState={{ expanded: open !== undefined }}
          disabled={rail.length === 0}
          onPress={() => setSelected(nextWorkflowSelection(rail, selected))}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2.5 active:opacity-70"
        >
          <View>
            <SymbolView
              name="point.3.connected.trianglepath.dotted"
              size={18}
              tintColorClassName="accent-icon-muted"
            />
            <View className="absolute -right-0.5 -top-0.5">
              <SubagentStatusDot tone={tone} />
            </View>
          </View>
          <Text
            numberOfLines={1}
            className="min-w-0 shrink font-t3-medium text-base text-foreground"
          >
            {label}
          </Text>
          {rail.length > 0 ? (
            <SymbolView
              name={open ? "chevron.up" : "chevron.down"}
              size={12}
              tintColorClassName="accent-icon-subtle"
            />
          ) : null}
        </Pressable>
        <WorkflowElapsed timing={group.workflow} />
        <SubagentStopButton environmentId={props.environmentId} subagent={props.subagent} />
      </View>
      {rail.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="-mx-3"
          contentContainerClassName="items-center px-3"
        >
          {rail.map((item, position) => {
            const icon = RAIL_ICON[item.tone];
            const isOpen = item.key === selected;
            const count =
              item.tone === "working" || item.tone === "failed"
                ? `${item.completedCount}/${item.members.length}`
                : null;
            return (
              <Fragment key={item.key}>
                {position > 0 ? <View className="mx-0.5 h-px w-2 bg-border" /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title} phase, ${item.tone}${count ? `, ${count} completed` : ""}`}
                  accessibilityState={{ expanded: isOpen }}
                  onPress={() => setSelected(nextWorkflowSelection(rail, selected, item.key))}
                  className="min-h-11 justify-center active:opacity-70"
                >
                  <View
                    className={cn(
                      "flex-row items-center gap-1.5 rounded-lg px-2 py-1",
                      isOpen && "bg-foreground/10",
                    )}
                  >
                    <SymbolView name={icon.name} size={13} tintColorClassName={icon.tint} />
                    <Text
                      numberOfLines={1}
                      className={cn(
                        "max-w-40 text-sm",
                        item.tone === "failed"
                          ? SUBAGENT_TONE_TEXT_CLASS.failed
                          : item.tone === "working" || isOpen
                            ? "text-foreground"
                            : "text-foreground-muted",
                      )}
                    >
                      {item.title}
                    </Text>
                    {count ? (
                      <Text className="text-xs tabular-nums text-foreground-muted">{count}</Text>
                    ) : null}
                  </View>
                </Pressable>
              </Fragment>
            );
          })}
        </ScrollView>
      ) : null}
      {open === undefined ? null : open.members.length === 0 ? (
        <Text className="pb-2 pl-1 text-xs text-foreground-muted">No agents yet</Text>
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
    <Pressable
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
      className="min-h-11 flex-row gap-2.5 py-2 pl-1 active:opacity-70"
    >
      <View className="h-5 justify-center">
        <SubagentStatusDot tone={presentation.tone} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="min-h-5 flex-row items-center gap-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
            {presentation.title}
          </Text>
          <WorkflowElapsed timing={member} />
          {canOpen ? (
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
          ) : null}
        </View>
        {labels.length > 0 || metadata.speed !== null ? (
          <View className="min-w-0 flex-row items-center">
            <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
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
                <Text className="text-xs text-adaptive-amber-700-300">{metadata.speed}</Text>
              </View>
            ) : metadata.speed !== null ? (
              <Text className="shrink-0 text-xs text-foreground-muted">{metadata.speed}</Text>
            ) : null}
          </View>
        ) : null}
        {detail ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {detail}
          </Text>
        ) : null}
        {error ? (
          <Text numberOfLines={1} className={cn("text-xs", SUBAGENT_TONE_TEXT_CLASS.failed)}>
            {error}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function WorkflowElapsed({
  timing,
}: {
  readonly timing: Parameters<typeof deriveSubagentElapsedMs>[0];
}) {
  const nowMs = useVisibleSecondClock(isActiveSubagentStatus(timing.status));
  const elapsedMs = deriveSubagentElapsedMs(timing, nowMs);
  return elapsedMs === null || elapsedMs === 0 ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">
      {formatDuration(elapsedMs)}
    </Text>
  );
}
