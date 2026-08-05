import {
  deriveOrchestrationV2SubagentPanelState,
  formatSubagentTokenCount,
  isSettledOrchestrationV2Subagent,
} from "@t3tools/client-runtime/state/orchestration-v2-subagents";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentActivation,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  ActivityIcon,
  BotIcon,
  ChevronDownIcon,
  CircleDotIcon,
  CoinsIcon,
  GitBranchIcon,
  WorkflowIcon,
} from "lucide-react";
import { useMemo } from "react";
import * as DateTime from "effect/DateTime";

import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";

const statusTone = (status: OrchestrationV2Subagent["status"]) =>
  status === "failed"
    ? "bg-destructive"
    : status === "running"
      ? "bg-emerald-500"
      : status === "pending" || status === "waiting"
        ? "bg-amber-500"
        : status === "idle"
          ? "bg-sky-500"
          : "bg-muted-foreground/50";

const usageSummary = (agent: OrchestrationV2Subagent) => {
  if (agent.usage === null) return null;
  return [
    `${formatSubagentTokenCount(agent.usage.totalTokens)} tokens`,
    agent.usage.toolUses === undefined ? null : `${agent.usage.toolUses} tools`,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");
};

const activationLabel = (activation: OrchestrationV2SubagentActivation) => {
  const usage =
    activation.usage === null
      ? null
      : `${formatSubagentTokenCount(activation.usage.totalTokens)} tokens`;
  return [`Run ${activation.ordinal}`, activation.status, usage]
    .filter((value): value is string => value !== null)
    .join(" · ");
};

const keyedActivities = (agent: OrchestrationV2Subagent) => {
  const occurrences = new Map<string, number>();
  return agent.recentActivity.map((activity) => {
    const base = `${DateTime.formatIso(activity.at)}:${activity.summary}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { activity, key: `${base}:${occurrence}` };
  });
};

function AgentCard(props: {
  agent: OrchestrationV2Subagent;
  activations: ReadonlyArray<OrchestrationV2SubagentActivation>;
}) {
  const { agent } = props;
  const detail = isSettledOrchestrationV2Subagent(agent)
    ? agent.result?.trim() || agent.progress?.trim() || agent.prompt.trim()
    : agent.progress?.trim() || agent.result?.trim() || agent.prompt.trim();
  const usage = usageSummary(agent);
  const activities = keyedActivities(agent);
  return (
    <article
      className="rounded-lg border border-border/70 bg-card/60 p-3"
      data-orchestration-v2-agent={agent.id}
      data-agent-status={agent.status}
    >
      <div className="flex min-w-0 items-start gap-2">
        <BotIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full", statusTone(agent.status))} />
            <h4 className="truncate text-sm font-medium">
              {agent.title?.trim() || agent.role.name}
            </h4>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
              {agent.status}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" size="sm">
              {agent.role.name}
            </Badge>
            {agent.role.source === "app_default" ? (
              <Badge variant="outline" size="sm">
                default role
              </Badge>
            ) : null}
            {agent.model === null ? null : (
              <Badge variant="outline" size="sm">
                {agent.model}
              </Badge>
            )}
          </div>
          {detail.length > 0 ? (
            <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {detail}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
            {usage === null ? null : (
              <span className="flex items-center gap-1">
                <CoinsIcon className="size-3" />
                {usage}
              </span>
            )}
            <span className="flex items-center gap-1">
              <GitBranchIcon className="size-3" />
              {agent.activationCount} {agent.activationCount === 1 ? "run" : "runs"}
            </span>
          </div>
        </div>
      </div>
      {agent.recentActivity.length > 0 || props.activations.length > 0 ? (
        <details className="group mt-3 border-t border-border/60 pt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon className="size-3 transition-transform group-open:rotate-180" />
            Activity and runs
          </summary>
          <div className="mt-2 space-y-2 pl-1">
            {activities.map(({ activity, key }) => (
              <div key={key} className="flex items-start gap-2 text-xs">
                <ActivityIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                <span className="break-words">{activity.summary}</span>
              </div>
            ))}
            {props.activations.map((activation) => (
              <div key={activation.id} className="flex items-start gap-2 text-xs">
                <CircleDotIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                <span>{activationLabel(activation)}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

export function AgentsPanelV2(props: { projection: OrchestrationV2ThreadProjection | null }) {
  const subagents = props.projection?.subagents ?? null;
  const activations = props.projection?.subagentActivations ?? null;
  const panel = useMemo(
    () =>
      subagents === null || activations === null
        ? null
        : deriveOrchestrationV2SubagentPanelState({
            subagents,
            activations,
          }),
    [activations, subagents],
  );

  if (panel === null || panel.groups.length === 0) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6 text-center"
        data-orchestration-v2-agents-empty
      >
        <div className="max-w-xs">
          <BotIcon className="mx-auto size-7 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No agents yet</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Provider-native and delegated agents will appear here with their usage, roles, runs, and
            recent activity.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-orchestration-v2-agents-panel>
      <header className="border-b border-border/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4" />
          <h2 className="text-sm font-medium">Agents</h2>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {panel.totalTokens === null
              ? "Usage unavailable"
              : `${formatSubagentTokenCount(panel.totalTokens)} tokens`}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
          <span>{panel.activeCount} active</span>
          <span>{panel.waitingCount} waiting</span>
          <span>{panel.settledCount} settled</span>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {panel.groups.map((group, groupIndex) => (
            <section
              key={group.workflow?.id ?? `direct:${groupIndex}`}
              className="space-y-2"
              data-agent-group={group.workflow?.id ?? "direct"}
            >
              {group.workflow === null ? null : (
                <>
                  <div className="flex items-center gap-2 px-1">
                    <WorkflowIcon className="size-4 text-muted-foreground" />
                    <h3 className="truncate text-xs font-medium">
                      {group.workflow.title?.trim() || "Workflow"}
                    </h3>
                  </div>
                  {/* The coordinator is an agent too: it has its own model,
                      usage and activations, and is the only row present at all
                      before its members are spawned. */}
                  <AgentCard
                    agent={group.workflow}
                    activations={panel.activationsBySubagentId.get(group.workflow.id) ?? []}
                  />
                </>
              )}
              {group.phases.map((phase) => (
                <div key={phase.index} className="space-y-2">
                  <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
                    <span className="font-mono">{phase.index + 1}</span>
                    <span className="truncate">{phase.title}</span>
                    <span className="ml-auto font-mono">{phase.status}</span>
                  </div>
                  {phase.agents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      activations={panel.activationsBySubagentId.get(agent.id) ?? []}
                    />
                  ))}
                </div>
              ))}
              {group.agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  activations={panel.activationsBySubagentId.get(agent.id) ?? []}
                />
              ))}
            </section>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
