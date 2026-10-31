import { type TimelineRow, TimelineRowCtx } from "./timelineRowContext";
import { subagentGroupTiming } from "./TimelineV2EventRow.logic";
import { WorkLogBlock } from "./WorkLog";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadDetails } from "../../state/threads";
import {
  subagentGroupSummary,
  summarizeSubagentStatuses,
} from "@t3tools/client-runtime/state/subagent-display";
import { memo, use, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import { EnvironmentSubagentAvatar, SubagentElapsed, V2LifecycleRow } from "./V2LifecycleRow";
import { LinkRequestCard } from "./LinkRequestCard";
import { SecretRequestCard } from "./SecretRequestCard";

export function V2EventTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "event" }> }) {
  const ctx = use(TimelineRowCtx);
  const { item, visibility } = row.projectedItem;
  if (item.type === "subagent" && (row.subagents?.length ?? 1) > 1) {
    return <V2SubagentGroup key={row.id} row={row} />;
  }
  if (item.type === "secret_request") {
    return (
      <SecretRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  if (item.type === "link_request") {
    return (
      <LinkRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  return (
    <V2LifecycleRow
      environmentId={ctx.activeThreadEnvironmentId}
      item={item}
      resourceSummary={row.resourceSummary}
      runs={ctx.runs}
      onOpenThread={ctx.onOpenThread}
    />
  );
}

export const V2SubagentGroup = memo(function V2SubagentGroup({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const groupId = `subagent-group:${row.id}`;
  const [expanded, setExpanded] = useState(() =>
    ctx.workGroupViewState.expandedEntries.has(groupId),
  );
  const members = (row.subagents ?? [row.projectedItem]).flatMap(({ item }) =>
    item.type === "subagent" ? [item] : [],
  );
  const liveAgents = useAtomValue(
    environmentThreadDetails.threadAtom(
      scopeThreadRef(ctx.activeThreadEnvironmentId, row.projectedItem.item.threadId),
    ),
    (thread) => thread?.projection.subagents,
  );
  const agents = members.map((item) => {
    const live = liveAgents?.find((agent) => agent.id === item.subagentId);
    return {
      item,
      status: live?.status ?? item.status,
      startedAt: live?.startedAt ?? item.startedAt,
      completedAt: live?.completedAt ?? item.completedAt,
    };
  });
  const summary = subagentGroupSummary(agents);
  const label = `${members.length} ${members.length === 1 ? "subagent" : "subagents"}`;
  const statusSummary = summarizeSubagentStatuses(agents.map(({ status }) => status));
  const toggleExpanded = (open: boolean) => {
    ctx.onToggleWorkEntry(row.id);
    if (open) ctx.workGroupViewState.expandedEntries.add(groupId);
    else ctx.workGroupViewState.expandedEntries.delete(groupId);
    setExpanded(open);
  };
  return (
    <WorkLogBlock continues={row.continuesWorkLog}>
      <Collapsible
        open={expanded}
        onOpenChange={toggleExpanded}
        data-subagent-group
        render={<div className="rounded-card surface-card p-1" />}
      >
        <CollapsibleTrigger
          aria-label={label}
          aria-description={statusSummary}
          className="flex h-10 w-full min-w-0 items-center gap-2.5 ps-2.5 pe-3.25"
        >
          <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden>
            {agents.slice(0, 3).map(({ item, status }, index) => (
              <EnvironmentSubagentAvatar
                key={item.id}
                className={cn(
                  "size-[22px] border-0 ring-(--subagent-avatar-ring,var(--card)) [&_svg]:size-3",
                  index === 0
                    ? "bg-(--subagent-avatar-1,var(--muted))"
                    : index === 1
                      ? "bg-(--subagent-avatar-2,var(--muted))"
                      : "bg-(--subagent-avatar-3,var(--muted))",
                )}
                environmentId={ctx.activeThreadEnvironmentId}
                providerInstanceId={item.providerInstanceId}
                driver={item.driver}
                remote={item.remoteChild}
                status={agents.length === 1 ? status : undefined}
              />
            ))}
            {agents.length > 3 ? (
              <span className="relative inline-flex size-[22px] items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground ring-2 ring-(--subagent-avatar-ring,var(--card))">
                +{agents.length - 3}
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-left text-xs font-medium text-foreground">{label}</span>
            <span
              className={cn(
                "block truncate text-left text-micro",
                summary.failed && !summary.active ? "text-error-foreground" : "text-dim-foreground",
              )}
            >
              {statusSummary}
            </span>
          </span>
          <span className="shrink-0 text-3xs font-medium text-dim-foreground tabular-nums">
            <SubagentElapsed agent={subagentGroupTiming(agents)} />
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-dim-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        {/* Virtualized rows must settle before disclosure scroll anchoring resumes. */}
        <CollapsiblePanel animate={false}>
          {expanded ? (
            <div className="pb-1">
              {members.map((item) => (
                <V2LifecycleRow
                  environmentId={ctx.activeThreadEnvironmentId}
                  key={item.id}
                  item={item}
                  runs={ctx.runs}
                  onOpenThread={ctx.onOpenThread}
                  subagentLayout="flat"
                />
              ))}
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </WorkLogBlock>
  );
});
