import {
  formatSubagentTokenCount,
  type OrchestrationV2WorkflowRunCardState,
} from "@t3tools/client-runtime/state/orchestration-v2-subagents";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ExternalLinkIcon, WorkflowIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "./ui/button";

const MAX_CARD_AGENT_ROWS = 8;

type WorkflowRunStatus = "running" | "completed" | "failed" | "stopped";

const RUN_STATUS_VISUALS: Record<
  WorkflowRunStatus,
  { label: string; dotClass: string; textClass: string; pulse: boolean }
> = {
  running: { label: "Running", dotClass: "bg-info", textClass: "text-info", pulse: true },
  completed: {
    label: "Completed",
    dotClass: "bg-success",
    textClass: "text-success",
    pulse: false,
  },
  failed: {
    label: "Failed",
    dotClass: "bg-destructive",
    textClass: "text-destructive",
    pulse: false,
  },
  stopped: {
    label: "Stopped",
    dotClass: "bg-muted-foreground",
    textClass: "text-muted-foreground",
    pulse: false,
  },
};

export function workflowRunCardStatus(
  status: OrchestrationV2Subagent["status"],
): WorkflowRunStatus {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "running";
    case "completed":
    case "idle":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

const AGENT_STATUS_DOT: Record<OrchestrationV2Subagent["status"], string> = {
  pending: "bg-muted-foreground/50",
  running: "bg-info animate-pulse",
  waiting: "bg-warning animate-pulse",
  idle: "bg-success",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
  interrupted: "bg-muted-foreground",
};

/**
 * Only web URLs may reach an anchor href. The adapter already filters the
 * scheme at ingestion; this guards payloads persisted before that filter
 * (and any other producer) as defense in depth.
 */
export function safeWorkflowSessionUrl(sessionUrl: string | undefined): string | undefined {
  if (sessionUrl === undefined) return undefined;
  try {
    const parsed = new URL(sessionUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? sessionUrl : undefined;
  } catch {
    return undefined;
  }
}

const agentActive = (agent: OrchestrationV2Subagent) =>
  agent.status === "running" || agent.status === "waiting" || agent.status === "failed";

/** Which member rows survive the card cap: running and failed first, then
 * most recently updated. The full list lives in the Agents panel. */
function visibleMemberIds(
  members: ReadonlyArray<OrchestrationV2Subagent>,
): Set<OrchestrationV2Subagent["id"]> {
  const prioritized = [...members].sort((left, right) => {
    const leftUrgent = agentActive(left) ? 0 : 1;
    const rightUrgent = agentActive(right) ? 0 : 1;
    if (leftUrgent !== rightUrgent) return leftUrgent - rightUrgent;
    return DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt);
  });
  return new Set(prioritized.slice(0, MAX_CARD_AGENT_ROWS).map((agent) => agent.id));
}

function MemberRow({ agent }: { agent: OrchestrationV2Subagent }) {
  const failed = agent.status === "failed";
  // Failures often surface only in the streamed result (a thrown value the
  // runner stringified) — fall back to it so red rows always explain why.
  const errorText = failed ? agent.result?.trim() || agent.progress?.trim() : undefined;
  const meta = [
    agent.model,
    agent.usage === null ? undefined : `${formatSubagentTokenCount(agent.usage.totalTokens)} tok`,
    failed ? undefined : agent.progress?.trim() || undefined,
  ]
    .filter((part): part is string => part !== undefined && part !== null && part.length > 0)
    .join(" · ");
  const attempt = agent.workflowMembership?.attempt ?? 1;
  return (
    <div
      className="flex min-w-0 items-start gap-1.5 px-0.5 py-0.5 text-[12px] leading-5"
      data-workflow-member={agent.id}
      data-agent-status={agent.status}
    >
      <span className="flex h-5 shrink-0 items-center">
        <span className={cn("size-1.5 shrink-0 rounded-full", AGENT_STATUS_DOT[agent.status])} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "break-words font-medium",
            failed ? "text-destructive" : "text-foreground/80",
          )}
        >
          {agent.title?.trim() || agent.role.name}
        </div>
        {(meta.length > 0 || attempt > 1 || errorText !== undefined) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-muted-foreground/60">
            {meta.length > 0 && <span className="tabular-nums">{meta}</span>}
            {attempt > 1 && (
              <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] leading-4 text-muted-foreground/80">
                retry {attempt}
              </span>
            )}
            {errorText !== undefined && (
              <span className="min-w-0 break-words text-destructive/75">{errorText}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PhaseHeader(props: { title: string; done: number; total: number }) {
  return (
    <div className="flex items-center justify-between gap-2 px-0.5 pt-1.5 pb-0.5">
      <span className="truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
        {props.title}
      </span>
      {props.total > 0 && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/55">
          {props.done}/{props.total}
        </span>
      )}
    </div>
  );
}

const isSettledMember = (agent: OrchestrationV2Subagent) =>
  agent.status !== "pending" && agent.status !== "running" && agent.status !== "waiting";

export function WorkflowRunCardV2(props: {
  card: OrchestrationV2WorkflowRunCardState;
  onOpenDetails?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
}) {
  const { card, onOpenDetails, onStop } = props;
  const { coordinator } = card;
  const status = workflowRunCardStatus(coordinator.status);
  const visual = RUN_STATUS_VISUALS[status];
  const title = coordinator.title?.trim() || coordinator.workflow?.name?.trim() || "Workflow";
  const sessionUrl = safeWorkflowSessionUrl(coordinator.workflow?.sessionUrl);
  const remote = coordinator.workflow?.sessionUrl !== undefined;
  const members = [...card.phases.flatMap((phase) => phase.agents), ...card.unphasedAgents];
  const overCap = members.length > MAX_CARD_AGENT_ROWS;
  const visibleIds = overCap ? visibleMemberIds(members) : null;
  const hiddenCount = overCap ? members.length - MAX_CARD_AGENT_ROWS : 0;
  const showStop = onStop !== undefined && status === "running";

  return (
    <div
      className="rounded-lg border border-border/70 bg-card/40 p-2.5"
      data-workflow-run-card={coordinator.id}
      data-workflow-status={status}
    >
      <div className="flex items-center gap-2">
        <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium text-foreground">{title}</span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 text-[11px] font-medium",
            visual.textClass,
          )}
        >
          <span className="relative flex size-1.5">
            {visual.pulse && (
              <span
                className={cn(
                  "absolute inline-flex size-full animate-ping rounded-full opacity-60",
                  visual.dotClass,
                )}
              />
            )}
            <span className={cn("relative inline-flex size-1.5 rounded-full", visual.dotClass)} />
          </span>
          {visual.label}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground/70">
            {card.memberCount > 0 && (
              <span>
                {card.settledMemberCount}/{card.memberCount} agents
              </span>
            )}
            {card.totalTokens !== null && (
              <span>{formatSubagentTokenCount(card.totalTokens)} tok</span>
            )}
          </div>
          {(showStop || onOpenDetails !== undefined) && (
            <div className="flex items-center gap-1.5">
              {showStop && (
                <Button type="button" size="xs" variant="outline" onClick={onStop}>
                  Stop
                </Button>
              )}
              {onOpenDetails !== undefined && (
                <Button type="button" size="xs" variant="outline" onClick={onOpenDetails}>
                  Details
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {remote ? (
        sessionUrl === undefined ? (
          <p className="mt-1.5 px-0.5 text-[12px] leading-5 text-muted-foreground/70">
            Running in the cloud
          </p>
        ) : (
          <a
            href={sessionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 flex items-center gap-1.5 rounded-md px-0.5 py-0.5 text-[12px] leading-5 text-foreground/80 hover:bg-accent/20 hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
            Running in the cloud — open session
          </a>
        )
      ) : members.length > 0 ? (
        <div className="mt-1 space-y-px">
          {card.phases.map((phase) => {
            const rows = phase.agents.filter(
              (agent) => visibleIds === null || visibleIds.has(agent.id),
            );
            if (rows.length === 0) return null;
            return (
              <div key={phase.index}>
                <PhaseHeader
                  title={phase.title}
                  done={phase.agents.filter(isSettledMember).length}
                  total={phase.agents.length}
                />
                {rows.map((agent) => (
                  <MemberRow key={agent.id} agent={agent} />
                ))}
              </div>
            );
          })}
          {card.unphasedAgents
            .filter((agent) => visibleIds === null || visibleIds.has(agent.id))
            .map((agent) => (
              <MemberRow key={agent.id} agent={agent} />
            ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              disabled={onOpenDetails === undefined}
              onClick={onOpenDetails}
              className={cn(
                "w-full px-0.5 py-0.5 text-left text-[12px] leading-5 text-muted-foreground/60",
                onOpenDetails !== undefined &&
                  "cursor-pointer rounded-md hover:bg-accent/20 hover:text-muted-foreground",
              )}
            >
              +{hiddenCount} more agents — open details
            </button>
          )}
        </div>
      ) : null}

      {coordinator.workflow?.warning !== undefined && (
        <p className="mt-1.5 text-[11px] text-warning">{coordinator.workflow.warning}</p>
      )}
    </div>
  );
}
