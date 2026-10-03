import {
  isTerminalSubagentStatus,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AgentElapsed } from "./AgentElapsed";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadRelationshipIcon } from "./ThreadRelationshipIcon";
import { cn } from "../../lib/utils";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * Wall clock for the phase: its members run in parallel, so the span from the
 * first start to the last finish is the time the phase actually took. Shaped
 * for AgentElapsed, which ticks it while the phase is still running.
 */
function phaseElapsed(phase: AgentPanelWorkflowGroup["phases"][number]) {
  const instants = (key: "startedAt" | "completedAt") =>
    phase.members
      .map((member) => member[key])
      .filter((value) => value !== null)
      .sort();
  const running = phase.state === "running";
  const startedAt = instants("startedAt")[0] ?? null;
  const completedAt = running ? null : (instants("completedAt").at(-1) ?? null);
  return {
    status: running ? ("running" as const) : ("completed" as const),
    // A settled phase whose members never reported an end has no span to show.
    startedAt: running || completedAt !== null ? startedAt : null,
    completedAt,
  };
}

/**
 * Phase state as the panel already says it elsewhere: a coloured dot, and the
 * running phase tinted so the active step is findable without reading counts.
 */
function phaseStatus(phase: AgentPanelWorkflowGroup["phases"][number]) {
  if (phase.state === "running") return { dot: "bg-info", label: "running" } as const;
  if (phase.members.some((member) => member.status === "failed")) {
    return { dot: "bg-destructive", label: "failed" } as const;
  }
  if (
    phase.members.some((member) => member.status === "cancelled" || member.status === "interrupted")
  ) {
    return { dot: "bg-muted-foreground/50", label: "stopped" } as const;
  }
  if (phase.state === "done") return { dot: "bg-success", label: "done" } as const;
  return { dot: "bg-muted-foreground/50", label: "not started" } as const;
}

/** Members run under the coordinator's provider, so they share its glyph. */
function WorkflowMemberRow({
  member,
  provider,
  driver,
  onOpen,
}: {
  member: RuntimeSubagent;
  provider: ServerProvider | undefined;
  driver: ProviderDriverKind | undefined;
  onOpen: (threadId: string) => void;
}) {
  const threadId = member.childThreadId;
  return (
    <li className="group">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              part="row"
              aria-label={`Open ${member.title} chat`}
              disabled={threadId === null}
              onClick={() => threadId !== null && onOpen(threadId)}
              className="min-w-0"
            />
          }
        >
          <ThreadRelationshipIcon driver={driver} provider={provider} status={member.status} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-foreground/85">
            {member.title}
          </span>
          <span className="sr-only">{member.status}</span>
          {member.startedAt ? (
            <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
              <AgentElapsed agent={member} />
            </span>
          ) : null}
        </TooltipTrigger>
        <ThreadHoverCardPopup side="left">
          <SubagentTooltipContent
            title={member.title}
            model={member.model}
            provider={provider}
            driver={driver}
            elapsed={<AgentElapsed agent={member} />}
            status={member.status}
            result={member.result ?? member.error}
            progress={member.progress}
          />
        </ThreadHoverCardPopup>
      </Tooltip>
    </li>
  );
}

export function ThreadLineageWorkflowRow({
  group,
  header,
  provider,
  driver,
  onOpenThread,
}: {
  readonly group: AgentPanelWorkflowGroup;
  readonly header: ReactNode;
  readonly provider: ServerProvider | undefined;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openPhases, setOpenPhases] = useState<ReadonlySet<number>>(() => new Set());
  const label = group.workflow.workflowName ?? group.workflow.title;
  const phases = group.phases.filter((phase) => phase.members.length > 0);
  return (
    // The flag lets the lineage list trade its compact height for the open tree.
    <li className="group" data-workflow-expanded={expanded ? "" : undefined}>
      <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
        {header}
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="secondary"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </ThreadDetailsControl>
      </div>
      {expanded ? (
        <ul className="m-0 list-none p-0 pe-8 ps-5">
          {phases.map((phase) => {
            const open = openPhases.has(phase.index);
            const status = phaseStatus(phase);
            return (
              <li key={phase.index} className="mt-1 first:mt-0">
                {/* Chevron sits in the member glyph's box, so titles share a column. */}
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenPhases((phases) => {
                      const next = new Set(phases);
                      if (!next.delete(phase.index)) next.add(phase.index);
                      return next;
                    })
                  }
                  className={cn(
                    "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium hover:bg-black/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 dark:hover:bg-white/[0.075]",
                    phase.state === "running"
                      ? "bg-info/8 text-info"
                      : "text-muted-foreground/65 hover:text-foreground/80",
                  )}
                >
                  <ChevronDownIcon
                    aria-hidden
                    className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
                  />
                  <span className="min-w-0 flex-1 truncate">{phase.title}</span>
                  <span className="shrink-0 font-normal opacity-70">
                    <AgentElapsed agent={phaseElapsed(phase)} />
                  </span>
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dot)} />
                  <span className="shrink-0 tabular-nums">
                    {phase.settledCount}/{phase.members.length}
                  </span>
                  <span className="sr-only">{status.label}</span>
                </button>
                {open ? (
                  <ul className="m-0 mt-0.5 list-none p-0">
                    {phase.members.map((member) => (
                      <WorkflowMemberRow
                        key={member.id}
                        member={member}
                        provider={provider}
                        driver={driver}
                        onOpen={onOpenThread}
                      />
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {group.unphasedMembers.map((member) => (
            <WorkflowMemberRow
              key={member.id}
              member={member}
              provider={provider}
              driver={driver}
              onOpen={onOpenThread}
            />
          ))}
          {phases.length === 0 && group.unphasedMembers.length === 0 ? (
            <li className="px-2.5 py-1.5 text-2xs text-muted-foreground/70">No agents yet</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function ThreadLineageWorkflowCount({ group }: { group: AgentPanelWorkflowGroup }) {
  const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const settled = members.filter((member) => isTerminalSubagentStatus(member.status)).length;
  return (
    <>
      {settled}/{members.length}
      <span className="sr-only"> agents settled</span>
    </>
  );
}
