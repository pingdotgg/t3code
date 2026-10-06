import {
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  projectedSubagentsToRuntime,
  liveSubagent,
  isActiveSubagentStatus,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  GitBranchIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { AgentElapsed } from "./AgentElapsed";

type WorkflowStatus = RuntimeSubagent["status"];

function statusLabel(status: WorkflowStatus) {
  switch (status) {
    case "pending":
      return "Queued";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
    case "idle":
      return "Idle";
  }
}

function StatusMark({ status }: { status: WorkflowStatus }) {
  const Icon = status === "completed" ? CheckIcon : status === "failed" ? XIcon : MinusIcon;
  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center"
      aria-label={statusLabel(status)}
    >
      {isActiveSubagentStatus(status) ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            status === "pending" ? "bg-muted-foreground/40" : "bg-info",
          )}
        />
      ) : (
        <Icon
          aria-hidden
          className={cn(
            "size-3.5",
            status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        />
      )}
    </span>
  );
}

/** The same ordered phase tree in the conversation and workspace lineage. */
export function WorkflowCard({
  agent,
  childThread,
  onOpenThread,
  inWorkflowThread = false,
  variant = "conversation",
  isThreadUnavailable,
}: {
  agent: OrchestrationV2Subagent;
  childThread?: OrchestrationV2ThreadShell | null | undefined;
  onOpenThread: (threadId: ThreadId) => void;
  inWorkflowThread?: boolean;
  variant?: "conversation" | "panel";
  isThreadUnavailable?: (threadId: ThreadId) => boolean;
}) {
  const panel = variant === "panel";
  const [expanded, setExpanded] = useState(!panel);
  const [scriptOpen, setScriptOpen] = useState(false);
  const detailsId = useId();
  const { childThreadId } = agent;
  const coordinatorUnavailable = childThreadId !== null && isThreadUnavailable?.(childThreadId);
  const runtime = projectedSubagentsToRuntime([agent]);
  const coordinator = liveSubagent(runtime[0], childThread)!;
  const members = runtime.slice(1);
  const phaseMap = new Map(coordinator.phases.map((phase) => [phase.index, phase.title]));
  for (const member of members) {
    if (member.phaseIndex !== null && !phaseMap.has(member.phaseIndex)) {
      phaseMap.set(member.phaseIndex, member.phaseTitle ?? `Phase ${member.phaseIndex}`);
    }
  }
  const phases = [...phaseMap]
    .sort(([a], [b]) => a - b)
    .map(([index, title]) => ({ index, title }));
  if (members.some((member) => member.phaseIndex === null)) {
    phases.push({ index: -1, title: "Other agents" });
  }
  const completed = members.filter((member) => member.status === "completed").length;
  const activeMember =
    members.find((member) => member.status === "running" || member.status === "waiting") ??
    members.find((member) => member.status === "pending");
  const currentPhase = activeMember
    ? (activeMember.phaseIndex ?? -1)
    : phases.findLast((phase) =>
        members.some((member) => (member.phaseIndex ?? -1) === phase.index),
      )?.index;
  const title = coordinator.workflowName ?? coordinator.title;
  const activePhaseTitle = activeMember
    ? (activeMember.phaseTitle ?? phaseMap.get(activeMember.phaseIndex ?? -1))
    : undefined;

  return (
    <section
      aria-label={`Workflow: ${title}`}
      data-workflow-card
      className={cn("min-w-0", !panel && "my-2 overflow-hidden rounded-lg border border-border/70")}
    >
      <div className={cn("flex items-start gap-2", panel ? "px-1.5 py-2" : "px-3 py-2.5")}>
        <GitBranchIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {panel && !inWorkflowThread && childThreadId !== null ? (
            <button
              type="button"
              aria-label={`Open workflow: ${title}`}
              disabled={coordinatorUnavailable}
              onClick={coordinatorUnavailable ? undefined : () => onOpenThread(childThreadId)}
              className="block max-w-full cursor-pointer truncate rounded-sm text-left text-xs font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
            >
              {title}
            </button>
          ) : (
            <span className="block break-words text-xs font-medium text-foreground">{title}</span>
          )}
          {activePhaseTitle ? (
            <span className="block truncate text-2xs text-muted-foreground">
              {activePhaseTitle}
            </span>
          ) : null}
          <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground">
            <span>Workflow</span>
            <span aria-hidden>·</span>
            <span>{statusLabel(coordinator.status)}</span>
            {members.length > 0 ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  {completed}/{members.length} agents
                </span>
              </>
            ) : null}
            <AgentElapsed agent={coordinator} />
          </span>
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={expanded ? "Collapse workflow" : "Expand workflow"}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDownIcon aria-hidden className={cn("size-3.5", !expanded && "-rotate-90")} />
        </Button>
      </div>
      {expanded ? (
        <div id={detailsId} className={cn(panel ? "ml-3.5" : "mx-3 mb-2")}>
          <div aria-label="Workflow phases" className="border-l border-border/70 pl-2">
            {phases.map((phase) => (
              <WorkflowPhase
                key={`${agent.id}:${phase.index}`}
                title={phase.title}
                members={members.filter((member) => (member.phaseIndex ?? -1) === phase.index)}
                coordinatorStatus={coordinator.status}
                defaultExpanded={phase.index === currentPhase}
                panel={panel}
                onOpenThread={onOpenThread}
                isThreadUnavailable={isThreadUnavailable}
              />
            ))}
            {phases.length === 0 ? (
              <p className="px-1 py-2 text-2xs text-muted-foreground">
                {isActiveSubagentStatus(coordinator.status)
                  ? "Waiting for agents…"
                  : "No agents reported"}
              </p>
            ) : null}
          </div>
          {agent.workflow?.truncated ? (
            <p className="px-1 py-2 text-2xs text-muted-foreground">
              This workflow exceeds the display limit. Some phases or agents are omitted.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
            {agent.prompt ? (
              <Button size="xs" variant="ghost-muted" onClick={() => setScriptOpen(true)}>
                <CodeIcon aria-hidden className="size-3" />
                View script
              </Button>
            ) : null}
            {!panel && !inWorkflowThread && childThreadId !== null ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={coordinatorUnavailable}
                onClick={coordinatorUnavailable ? undefined : () => onOpenThread(childThreadId)}
              >
                Open workflow
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <Dialog open={scriptOpen} onOpenChange={setScriptOpen}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Workflow script</DialogTitle>
          </DialogHeader>
          <div className="flex h-[70vh] min-h-0 flex-col">
            <ReadOnlySourcePreview name="workflow.js" text={agent.prompt} />
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

function WorkflowPhase({
  title,
  members,
  coordinatorStatus,
  defaultExpanded,
  panel,
  onOpenThread,
  isThreadUnavailable,
}: {
  title: string;
  members: RuntimeSubagent[];
  coordinatorStatus: WorkflowStatus;
  defaultExpanded: boolean;
  panel: boolean;
  onOpenThread: (threadId: ThreadId) => void;
  isThreadUnavailable: ((threadId: ThreadId) => boolean) | undefined;
}) {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? defaultExpanded;
  const membersId = useId();
  const completed = members.filter((member) => member.status === "completed").length;
  const failed = members.some((member) => member.status === "failed");
  const active = members.some((member) => isActiveSubagentStatus(member.status));
  const summary =
    members.length > 0
      ? `${completed}/${members.length}${failed ? " · failed" : active ? " · active" : ""}`
      : isActiveSubagentStatus(coordinatorStatus)
        ? "Upcoming"
        : "No agents";
  return (
    <div>
      <button
        type="button"
        aria-label={`${title}: ${summary}`}
        aria-expanded={expanded}
        aria-controls={membersId}
        onClick={() => setUserExpanded(!expanded)}
        className="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 text-left hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 text-muted-foreground", !expanded && "-rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        <span
          className={cn(
            "shrink-0 text-2xs tabular-nums",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {summary}
        </span>
      </button>
      {expanded ? (
        <ul
          id={membersId}
          aria-label={`${title} agents`}
          className="mb-1 ml-2.5 list-none border-l border-border/50 pl-2"
        >
          {members.map((member) => (
            <li key={member.id}>
              <WorkflowMember
                agent={member}
                panel={panel}
                onOpenThread={onOpenThread}
                unavailable={Boolean(
                  member.childThreadId &&
                  isThreadUnavailable?.(ThreadId.make(member.childThreadId)),
                )}
              />
            </li>
          ))}
          {members.length === 0 ? (
            <li className="px-1 py-2 text-2xs text-muted-foreground">
              {isActiveSubagentStatus(coordinatorStatus)
                ? "Waiting for agents in this phase."
                : "No agents were reported for this phase."}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function WorkflowMember({
  agent,
  panel,
  onOpenThread,
  unavailable,
}: {
  agent: RuntimeSubagent;
  panel: boolean;
  onOpenThread: (threadId: ThreadId) => void;
  unavailable?: boolean;
}) {
  const childThreadId = agent.childThreadId ? ThreadId.make(agent.childThreadId) : null;
  const content = (
    <>
      <StatusMark status={agent.status} />
      <span className="min-w-0 flex-1 truncate text-xs">{agent.title}</span>
      {agent.attempt !== null && agent.attempt > 1 ? (
        <span className="shrink-0 text-3xs text-muted-foreground">#{agent.attempt}</span>
      ) : null}
      {!panel && agent.model ? (
        <span className="max-w-28 truncate text-3xs text-muted-foreground">{agent.model}</span>
      ) : null}
      <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
        <AgentElapsed agent={agent} />
      </span>
      {childThreadId ? (
        <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
      ) : null}
    </>
  );
  const className = "flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-sm px-1 text-left";
  const description = [
    statusLabel(agent.status),
    agent.model,
    agent.lastToolName ? `Last tool: ${agent.lastToolName}` : null,
    agent.usage ? `${agent.usage.totalTokens.toLocaleString()} tokens` : null,
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tool calls` : null,
    agent.attempt && agent.attempt > 1 ? `Attempt ${agent.attempt}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          childThreadId ? (
            <button
              type="button"
              aria-label={`Open ${agent.title}`}
              disabled={unavailable}
              onClick={unavailable ? undefined : () => onOpenThread(childThreadId)}
              className={cn(
                className,
                "cursor-pointer hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent",
              )}
            />
          ) : (
            <div className={className} tabIndex={0} />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup>
        {agent.title} · {unavailable ? "This related thread is unavailable" : description}
      </TooltipPopup>
    </Tooltip>
  );
}
