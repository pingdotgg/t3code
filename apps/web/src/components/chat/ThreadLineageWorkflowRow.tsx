/**
 * Lineage row for a workflow coordinator. It unfolds in place — phases, then
 * one line per member — because a run's members are invisible anywhere else.
 */
import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentElapsed, StatusDot } from "../AgentsPanel";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { THREAD_DETAILS_PANEL_LINK_ROW_CLASS } from "./threadDetailsPanelStyles";

/** Beyond this the dots crowd the run's name out of a ~312px card. */
const MAX_INLINE_DOTS = 4;

function MemberRow({
  member,
  onOpen,
}: {
  member: RuntimeSubagent;
  onOpen: (threadId: string) => void;
}) {
  const threadId = member.childThreadId;
  return (
    // Flex so the row button's flex-1 has something to stretch against;
    // without it the button shrink-wraps and the elapsed time floats mid-row.
    <li className="flex items-center">
      <Button
        size="sm"
        variant="ghost"
        disabled={threadId === null}
        onClick={() => threadId !== null && onOpen(threadId)}
        className={cn(
          THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
          "h-6 gap-2 pl-7 pr-2.5 text-[12px] font-normal sm:h-6 sm:text-[12px]",
        )}
      >
        <StatusDot status={member.status} />
        <span className="min-w-0 flex-1 truncate text-left">{member.title}</span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          <AgentElapsed agent={member} />
        </span>
      </Button>
    </li>
  );
}

function PhaseRows({
  phase,
  onOpen,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  onOpen: (threadId: string) => void;
}) {
  if (phase.members.length === 0) return null;
  return (
    <>
      <li className="flex h-5 items-center gap-1.5 px-2.5">
        <CheckIcon
          aria-hidden
          className={cn(
            "size-2.5 shrink-0 text-success-foreground",
            phase.state !== "done" && "invisible",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate text-[10px] font-medium uppercase tracking-wider",
            phase.state === "done"
              ? "text-success-foreground"
              : phase.state === "running"
                ? "text-info-foreground"
                : "text-muted-foreground/70",
          )}
        >
          {phase.title}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {phase.settledCount}/{phase.members.length}
        </span>
      </li>
      {phase.members.map((member) => (
        <MemberRow key={member.id} member={member} onOpen={onOpen} />
      ))}
    </>
  );
}

export function ThreadLineageWorkflowRow(props: {
  readonly group: AgentPanelWorkflowGroup;
  readonly header: ReactNode;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { group } = props;
  const label = group.workflow.workflowName ?? group.workflow.title;
  const hasMembers =
    group.unphasedMembers.length > 0 || group.phases.some((phase) => phase.members.length > 0);
  return (
    <li className="group">
      <div className="flex h-9 items-center rounded-lg">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          onClick={() => setExpanded((value) => !value)}
          className="size-5 shrink-0 border-transparent bg-transparent p-0 text-muted-foreground sm:size-5"
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5" />
          )}
        </Button>
        {props.header}
      </div>
      {expanded ? (
        <ul className="m-0 list-none p-0 pb-1">
          {group.phases.map((phase) => (
            <PhaseRows key={phase.index} phase={phase} onOpen={props.onOpenThread} />
          ))}
          {group.unphasedMembers.map((member) => (
            <MemberRow key={member.id} member={member} onOpen={props.onOpenThread} />
          ))}
          {/* Reachable: coordinator, or declared phases, with no members yet. */}
          {!hasMembers ? (
            <li className="px-7 py-1 text-[11px] text-muted-foreground/70">No agents yet</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** Status dots for the collapsed row, capped so they cannot crowd out its name. */
export function ThreadLineageWorkflowDots({ group }: { group: AgentPanelWorkflowGroup }) {
  const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  if (members.length === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      aria-label={`${members.length} agents`}
      role="img"
    >
      {members.slice(0, MAX_INLINE_DOTS).map((member) => (
        <StatusDot key={member.id} status={member.status} />
      ))}
    </span>
  );
}
