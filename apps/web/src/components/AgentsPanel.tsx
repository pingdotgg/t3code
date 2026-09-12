/**
 * Agents right-panel surface: the fleet view over the native subagent fold,
 * and the ONLY place the roster renders (the chat carries one CTA row per
 * spawn batch).
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable. Activity and completion update rows in place.
 * - Agent cards reserve one row for identity and one for activity + metrics;
 *   changing data must never change their height.
 * - Workflow expansion is presentation state. A live run stays expanded when
 *   it settles; older collapsed runs can still be opened at run granularity.
 * - Static status chips, DOM-write elapsed timers, plain token counters.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Bot, Braces, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { allPanelAgents, workflowIsVisible, workflowMembers } from "./AgentsPanel.logic";

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
const STATUS_VISUALS: Record<
  RuntimeSubagent["status"],
  { dotClass: string; chipClass: string; label: string }
> = {
  pending: { dotClass: "bg-info", chipClass: "bg-info/12 text-info-foreground", label: "Working" },
  running: { dotClass: "bg-info", chipClass: "bg-info/12 text-info-foreground", label: "Working" },
  waiting: { dotClass: "bg-info", chipClass: "bg-info/12 text-info-foreground", label: "Working" },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed — live-test: sky idle dots read as stuck in-progress.
  idle: {
    dotClass: "bg-muted-foreground/50",
    chipClass: "bg-muted text-muted-foreground",
    label: "Idle",
  },
  completed: {
    dotClass: "bg-success",
    chipClass: "bg-success/14 text-success-foreground",
    label: "Done",
  },
  failed: {
    dotClass: "bg-destructive",
    chipClass: "bg-destructive/12 text-destructive-foreground",
    label: "Failed",
  },
  cancelled: {
    dotClass: "bg-muted-foreground/60",
    chipClass: "bg-muted text-muted-foreground",
    label: "Stopped",
  },
  interrupted: {
    dotClass: "bg-muted-foreground/60",
    chipClass: "bg-muted text-muted-foreground",
    label: "Stopped",
  },
};

/** Render the status marker used by compact workflow summaries and the fleet meter. */
function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

/** Format an elapsed duration without sub-second churn. */
function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Calculate an agent activation's elapsed display from persisted timestamps. */
function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

/** Compact card for one agent: identity above its latest activity and metrics. */
function AgentRow({ agent }: { agent: RuntimeSubagent }) {
  const visuals = STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-2">
        <span className="truncate text-[.8125rem] font-medium">{agent.title}</span>
        <span className="truncate font-mono text-[.65rem] text-muted-foreground/75">
          {modelLabel}
        </span>
        <span className={cn("rounded-md px-1.5 py-0.5 text-[.6875rem]", visuals.chipClass)}>
          {visuals.label}
        </span>
      </div>
      <div className="flex items-center gap-2 border-t border-border/70 px-3 py-1.5 text-[.6875rem] text-muted-foreground">
        <span
          className={cn(
            "min-w-0 truncate",
            isActiveSubagentStatus(agent.status) && "font-mono text-info-foreground",
          )}
        >
          {activity ?? visuals.label}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono">
          {agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : null}
          <AgentElapsed agent={agent} />
        </span>
      </div>
    </div>
  );
}

/** Keep workflow presentation expanded while its coordinator has not settled. */
function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section. A phase opens when it becomes active, then keeps
 * that shape as it settles so completion never yanks rows out from under the
 * user. Manual toggles stick until a later activation begins.
 */
function PhaseSection({
  phase,
  defaultOpen = false,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || phase.state === "running");
  const previousState = useRef(phase.state);
  const members = phase.members.filter((member) => isActiveSubagentStatus(member.status));

  useEffect(() => {
    if (previousState.current !== "running" && phase.state === "running") {
      setOpen(true);
    }
    previousState.current = phase.state;
  }, [phase.state]);

  if (members.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-sm px-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        <span className="font-medium text-foreground/75">{phase.title}</span>
        <span>{members.length} working</span>
        {!open ? (
          <span className="ml-auto flex items-center gap-0.5">
            {members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open ? members.map((member) => <AgentRow key={member.id} agent={member} />) : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group).filter((member) =>
    isActiveSubagentStatus(member.status),
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 px-1 pt-0.5">
        <span className="min-w-0 truncate text-[.8125rem] font-semibold">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "ml-auto rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="font-mono text-[.6875rem] text-muted-foreground">{members} working</span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onCollapse}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </div>
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.map((phase) => (
        <PhaseSection key={phase.index} phase={phase} />
      ))}
      {group.unphasedMembers
        .filter((member) => isActiveSubagentStatus(member.status))
        .map((member) => (
          <AgentRow key={member.id} agent={member} />
        ))}
    </section>
  );
}

/**
 * Collapsed workflow: one summary line. The parent owns expansion so a live
 * workflow keeps its shape when it settles.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group).filter((member) => isActiveSubagentStatus(member.status));
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={false}
      >
        <StatusDot status={group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, not a status derivative. */
function WorkflowSection({
  group,
  environmentId,
  threadId,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const [open, setOpen] = useState(() => workflowIsLive(group));
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => setOpen(false)}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => setOpen(true)} />
  );
}

/** Fixed-width fleet meter: one segment per agent without growing the header. */
function FleetMeter({ agents }: { agents: ReadonlyArray<RuntimeSubagent> }) {
  return (
    <span
      aria-hidden
      className={cn("flex w-14 shrink-0 overflow-hidden", agents.length <= 14 && "gap-0.5")}
    >
      {agents.map((agent) => (
        <span
          key={agent.id}
          className={cn(
            "h-[3px] min-w-0 flex-1 rounded-[1px]",
            agent.status === "completed"
              ? "bg-success"
              : isActiveSubagentStatus(agent.status)
                ? "bg-info"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

/** Render the complete source-neutral agent roster for one thread. */
export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
}) {
  const [finishedOpen, setFinishedOpen] = useState(true);
  const allAgents = allPanelAgents(model);
  const liveDirect = model.directAgents.filter((agent) => isActiveSubagentStatus(agent.status));
  const finished = allAgents.filter((agent) => !isActiveSubagentStatus(agent.status));

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up here with live status,
          activity, and token usage.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
        {model.liveCount > 0 ? (
          <span className="text-info-foreground">{model.liveCount} working</span>
        ) : (
          <span>All agents finished</span>
        )}
        <FleetMeter agents={allAgents} />
        {model.totalTokens > 0 ? (
          <span className="ml-auto border-l border-border pl-2 font-mono text-[.6875rem] tabular-nums">
            {formatSubagentTokenCount(model.totalTokens)} tok
          </span>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-2.5">
          {model.workflows.filter(workflowIsVisible).map((group) => (
            <WorkflowSection
              key={group.workflow.id}
              group={group}
              environmentId={environmentId}
              threadId={threadId}
            />
          ))}
          {liveDirect.length > 0 ? (
            <section className="flex flex-col gap-2.5">
              <div className="px-1 pt-0.5 text-xs text-muted-foreground">
                Spawned directly{" "}
                <span className="font-mono text-[.6875rem]">{liveDirect.length}</span>
              </div>
              {liveDirect.map((agent) => (
                <AgentRow key={agent.id} agent={agent} />
              ))}
            </section>
          ) : null}
          {finished.length > 0 ? (
            <section className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => setFinishedOpen((open) => !open)}
                aria-expanded={finishedOpen}
                className="flex items-center gap-1.5 rounded-sm px-1 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronDown
                  aria-hidden
                  className={cn("size-3 transition-transform", !finishedOpen && "-rotate-90")}
                />
                <span className="font-medium text-foreground/75">Finished</span>
                <span>{finished.length}</span>
              </button>
              {finishedOpen
                ? finished.map((agent) => <AgentRow key={agent.id} agent={agent} />)
                : null}
            </section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
