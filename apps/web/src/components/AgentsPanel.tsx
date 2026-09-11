/**
 * Agents right-panel surface: the fleet view over the native subagent fold,
 * and the ONLY place the roster renders (the chat carries one CTA row per
 * spawn batch).
 *
 * Shape, from design review:
 * - One agent is one card: title + model/effort + a state chip, over a strip
 *   carrying the tool it is on right now, its cost, and its clock.
 * - Finished agents leave the run and collect under a Finished disclosure, so
 *   the roster keeps live work at full size.
 * - An expanded card reads its latest saved tools; "Open full activity"
 *   opens the newest history page, with older pages available on demand.
 * - State reads as a word, never as colour alone; the clock tints while an
 *   agent works and the chip names the outcome when it stops.
 * - Spawn order is stable. Activity and completion update cards in place.
 * - Static status text, DOM-write elapsed timers, one width transition per
 *   tool change. No continuously repainting animation.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";
import { Braces, Bot, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { deriveAgentWorkEntries } from "~/session-logic";
import { useEnvironmentQuery } from "~/state/query";
import { orchestrationEnvironment } from "~/state/orchestration";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { workEntryDisplayLabel } from "./chat/MessagesTimeline.logic";
import {
  allPanelAgents,
  expansionsAfterCollapse,
  finishedAgents,
  isLiveAgent,
} from "./AgentsPanel.logic";

/**
 * In-flight states all present as Working (one steady state: a stalled,
 * waiting or queued subagent is still the fleet doing its job, not a user
 * problem). Only settled states differentiate, and each names its outcome.
 */
const STATUS_LABELS: Record<RuntimeSubagent["status"], string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

const CHIP_CLASSES: Record<RuntimeSubagent["status"], string> = {
  pending: "bg-info/12 text-info-foreground",
  running: "bg-info/12 text-info-foreground",
  waiting: "bg-info/12 text-info-foreground",
  idle: "bg-muted-foreground/12 text-muted-foreground",
  completed: "bg-success/14 text-success-foreground",
  failed: "bg-destructive/12 text-destructive-foreground",
  cancelled: "bg-muted-foreground/12 text-muted-foreground",
  interrupted: "bg-muted-foreground/12 text-muted-foreground",
};

const isLive = isLiveAgent;

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
function AgentElapsed({ agent, className }: { agent: RuntimeSubagent; className?: string }) {
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
    <span ref={textRef} className={cn("tabular-nums", live && "text-info-foreground", className)}>
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Swaps a live line's text so the trailing chevron travels to its new position
 * instead of teleporting. One width+opacity transition per tool change — a
 * handful of frames every few seconds, confined to this inline-block, so
 * layout never escapes it. Reduced motion swaps outright.
 */
function GlideText({ text, className }: { text: string; className?: string }) {
  const nodeRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node || node.textContent === text) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.textContent = text;
      return;
    }
    clearTimeout(timerRef.current);
    const from = node.getBoundingClientRect().width;
    node.style.transition = "none";
    node.style.width = "auto";
    node.textContent = text;
    const to = node.getBoundingClientRect().width;
    node.style.width = `${from}px`;
    node.style.opacity = "0.35";
    void node.offsetWidth;
    node.style.transition = "width 260ms cubic-bezier(.2,.7,.3,1), opacity 200ms ease";
    node.style.width = `${to}px`;
    node.style.opacity = "1";
    // A change arriving mid-flight orphans transitionend and would leave a
    // stale inline width behind, which clips the next line.
    timerRef.current = setTimeout(() => {
      node.style.transition = "";
      node.style.width = "";
    }, 300);
  }, [text]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <span
      ref={nodeRef}
      className={cn("inline-block overflow-hidden whitespace-nowrap align-baseline", className)}
    >
      {text}
    </span>
  );
}

/** What the agent is on right now, or the last thing it touched. */
function currentStepText(agent: RuntimeSubagent): string | null {
  if (agent.lastToolName) {
    return agent.lastToolName;
  }
  return agent.progress ?? agent.recentActivity.at(-1)?.summary ?? null;
}

/**
 * Settled agents lead with their outcome, live ones with what they are doing.
 * The two are set differently: a tool line is a machine value and reads as
 * mono, a result is the agent's own prose and does not.
 */
function cardSubtitle(agent: RuntimeSubagent): { text: string; mono: boolean } | null {
  if (isLive(agent)) {
    const step = currentStepText(agent);
    return step === null ? null : { text: step, mono: true };
  }
  const outcome = agent.error ?? agent.result;
  if (outcome !== null) {
    return { text: outcome, mono: false };
  }
  const step = currentStepText(agent);
  return step === null ? null : { text: step, mono: true };
}

/** Pair each status color with a readable label so color is never the only status signal. */
function AgentChip({ agent }: { agent: RuntimeSubagent }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1.5 py-px text-[.6875rem] leading-[1.4]",
        CHIP_CLASSES[agent.status],
      )}
    >
      {STATUS_LABELS[agent.status]}
    </span>
  );
}

/**
 * The agent's own work log, derived only when a card is open. Rows come from
 * the same derivation the chat uses, so an agent's tools render like the
 * thread's own.
 */
function AgentSteps({
  activities,
  agentId,
  workspaceRoot,
  limit,
}: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  agentId: string;
  workspaceRoot: string | undefined;
  limit?: number;
}) {
  const entries = useMemo(() => {
    const derived = deriveAgentWorkEntries(activities, agentId);
    return limit === undefined ? derived : derived.slice(-limit);
  }, [activities, agentId, limit]);

  if (entries.length === 0) {
    return (
      <p className="px-0.5 py-1 text-xs text-muted-foreground">
        No recent tool activity is available here. Open full activity to check the agent's saved
        history.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={cn(
            "rounded-md border border-border bg-card px-2.5 py-1.5 text-[.8125rem] leading-normal",
            entry.tone === "error" && "border-destructive/35",
          )}
        >
          <span className="block truncate font-mono text-[.95em] text-foreground/70">
            {workEntryDisplayLabel(entry, workspaceRoot)}
          </span>
          {entry.detail ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {entry.detail}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Only expanded cards query saved tools. Hidden windows and in-flight reads do not poll. */
function RecentAgentTools({
  agent,
  environmentId,
  threadId,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const history = useEnvironmentQuery(
    orchestrationEnvironment.agentHistory({
      environmentId,
      input: { threadId, agentId: agent.id, offset: 0, view: "recent-tools" },
    }),
  );
  const refresh = useEffectEvent(() => {
    if (document.visibilityState === "visible" && !history.isPending) history.refresh();
  });
  const live = isLiveAgent(agent);
  useEffect(() => {
    refresh();
    if (!live) return;
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [live]);
  const entries = history.data?.entries ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="min-w-0 rounded-md border border-border bg-card px-2.5 py-1.5"
        >
          <span className="block truncate font-mono text-[.8125rem] text-foreground/70">
            {entry.title}
          </span>
          {entry.detail && entry.kind !== "file-edit" ? (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {entry.detail}
            </span>
          ) : null}
        </div>
      ))}
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground" role="status">
          {history.isPending
            ? "Loading recent tools…"
            : (history.error ?? history.data?.message ?? "No tool activity yet.")}
        </p>
      ) : null}
    </div>
  );
}

/** One agent. Opens in place; the full log is a deliberate second step. */
function AgentCard({
  agent,
  activities,
  workspaceRoot,
  expanded,
  onToggle,
  onOpen,
  environmentId,
  threadId,
}: {
  agent: RuntimeSubagent;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  workspaceRoot: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const step = cardSubtitle(agent);
  const tokens = agent.usage?.totalTokens ?? 0;
  const live = isLive(agent);

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 px-3 pt-2.5 text-left hover:bg-accent/40"
      >
        <span className="truncate text-[.8125rem] font-medium">{agent.title}</span>
        {modelLabel ? (
          <span className="min-w-0 truncate font-mono text-[.65rem] text-muted-foreground/75">
            {modelLabel}
          </span>
        ) : (
          <span />
        )}
        <AgentChip agent={agent} />
        <span className="-mx-3 col-span-3 flex items-center gap-2 border-t border-border/70 px-3 py-1.5 text-[.6875rem] text-muted-foreground">
          {step ? (
            live ? (
              <GlideText text={step.text} className="min-w-0 font-mono text-info-foreground" />
            ) : (
              <span className={cn("min-w-0 truncate", step.mono && "font-mono")}>{step.text}</span>
            )
          ) : (
            <span className="min-w-0 truncate">{STATUS_LABELS[agent.status]}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono">
            {tokens > 0 ? <span>{formatSubagentTokenCount(tokens)} tok</span> : null}
            <AgentElapsed agent={agent} />
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground/70 transition-[rotate] duration-150 motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border/70">
          <div className="p-3">
            {environmentId && threadId ? (
              <RecentAgentTools agent={agent} environmentId={environmentId} threadId={threadId} />
            ) : (
              <AgentSteps
                activities={activities}
                agentId={agent.id}
                workspaceRoot={workspaceRoot}
                limit={5}
              />
            )}
          </div>
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open full activity for ${agent.title}`}
            className="flex w-full items-center justify-between border-t border-border/70 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open full activity
            <ChevronRight aria-hidden className="size-3" />
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Collapsible heading. Collapsing also closes anything expanded inside it. */
function Section({
  title,
  meta,
  folded,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta: string;
  folded: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-sm px-1 pt-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-[rotate] duration-150 motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
        <span className="font-medium text-foreground/75">{title}</span>
        <span>{meta}</span>
        {open ? null : <span className="ml-auto font-mono text-[.6875rem]">{folded}</span>}
      </button>
      {open ? children : null}
    </div>
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
    <div className="rounded-md border border-border/60 bg-background/60">
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

/** History belongs to the selected environment; it is fetched only while this view is open. */
function AgentHistory({
  agentId,
  environmentId,
  threadId,
}: {
  agentId: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [offset, setOffset] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const history = useEnvironmentQuery(
    orchestrationEnvironment.agentHistory({
      environmentId,
      input: {
        threadId,
        agentId,
        offset: offset ?? 0,
        ...(offset === null ? { view: "latest" as const } : {}),
      },
    }),
  );
  const pageOffset = offset ?? history.data?.startOffset ?? 0;
  useEffect(() => {
    if (offset === null && history.data && !history.isPending)
      bottom.current?.scrollIntoView({ block: "end" });
  }, [offset, history.data, history.isPending]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Saved agent activity</span>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={history.isPending}
          onClick={history.refresh}
        >
          Refresh
        </Button>
      </div>
      {history.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading activity…
        </p>
      ) : null}
      {history.error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {history.error}
        </p>
      ) : null}
      {history.data?.message ? (
        <p className="text-xs text-muted-foreground">{history.data.message}</p>
      ) : null}
      {history.data?.status === "ready" &&
      history.data.entries.length === 0 &&
      !history.isPending ? (
        <p className="text-xs text-muted-foreground">
          No saved activity is available yet. Refresh to check again.
        </p>
      ) : null}
      {history.data?.entries.map((entry) => {
        const tool = entry.kind === "tool" || entry.kind === "file-edit";
        const detail = (
          <>
            {entry.detail ? (
              <pre
                className={cn(
                  "mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground",
                  tool ? "font-mono" : "font-sans",
                )}
              >
                {entry.detail}
              </pre>
            ) : null}
            {entry.truncated ? (
              <p className="mt-1 text-xs text-muted-foreground">Long entry shortened.</p>
            ) : null}
          </>
        );
        return tool ? (
          <details
            key={entry.id}
            className="min-w-0 rounded-md border border-border bg-card px-2.5 py-2"
          >
            <summary className="cursor-pointer break-words font-mono text-xs text-foreground/80">
              {entry.title}
            </summary>
            {detail}
          </details>
        ) : (
          <div
            key={entry.id}
            className="min-w-0 rounded-md border border-border bg-card px-2.5 py-2"
          >
            <p className="whitespace-pre-wrap break-words text-xs text-foreground/80">
              {entry.title}
            </p>
            {detail}
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-2">
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={pageOffset === 0 || history.isPending}
          onClick={() => setOffset(Math.max(0, pageOffset - 50))}
        >
          Previous
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={history.data?.nextOffset == null || history.isPending}
          onClick={() => {
            if (history.data?.nextOffset != null) setOffset(history.data.nextOffset);
          }}
        >
          Next
        </Button>
      </div>
      <div ref={bottom} />
    </div>
  );
}

/** The whole agent: its full work log, its cost, and how to get back. */
function AgentActivityView({
  agent,
  environmentId,
  threadId,
  onBack,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onBack: () => void;
}) {
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const tokens = agent.usage?.totalTokens ?? 0;
  const summary = agent.error ?? agent.result;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[.6875rem] text-muted-foreground/80">
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onBack}
          aria-label="Back to all agents"
        >
          <ChevronLeft aria-hidden className="size-3" />
        </Button>
        <span className="ml-auto tabular-nums">
          {tokens > 0 ? `${formatSubagentTokenCount(tokens)} tok` : "no tokens"}
        </span>
        {agent.usage?.toolUses !== undefined ? (
          <span className="border-l border-border pl-2 tabular-nums">
            {agent.usage.toolUses} tools
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="min-w-0 truncate text-[.9375rem] font-semibold tracking-[-0.006em]">
            {agent.title}
          </h2>
          {modelLabel ? (
            <span className="ml-auto shrink-0 font-mono text-[.6875rem] text-muted-foreground/80">
              {modelLabel}
            </span>
          ) : null}
        </div>
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className={cn(isLive(agent) && "font-medium text-info-foreground")}>
            {STATUS_LABELS[agent.status]}
          </span>
          <AgentElapsed agent={agent} className="ml-auto font-mono text-[.6875rem]" />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 p-3">
          {environmentId !== null && threadId !== null ? (
            <AgentHistory
              key={`${environmentId}:${threadId}:${agent.id}`}
              agentId={agent.id}
              environmentId={environmentId}
              threadId={threadId}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Connect to the thread's environment to load agent history.
            </p>
          )}
          {summary ? (
            <p
              className={cn(
                "rounded-md border border-border bg-card/55 px-2.5 py-2 text-[.8125rem] leading-normal",
                agent.error ? "text-destructive-foreground" : "text-foreground/85",
              )}
            >
              {summary}
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

/** Progress meter: fixed width, segments share it, so 30 agents read like 5. */
function FleetMeter({ agents }: { agents: ReadonlyArray<RuntimeSubagent> }) {
  return (
    <span aria-hidden className="flex w-14 shrink-0 gap-0.5">
      {agents.map((agent) => (
        <span
          key={agent.id}
          className={cn(
            "h-[3px] min-w-0.5 flex-1 rounded-[1px]",
            agent.status === "completed"
              ? "bg-success"
              : isLive(agent)
                ? "bg-info"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

/** Stable identity: a literal default would break the derivation's memo. */
const NO_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];

/** Keep expansion local to the roster while routing saved history through the selected environment. */
export function AgentsPanel({
  model,
  activities = NO_ACTIVITIES,
  workspaceRoot,
  environmentId = null,
  threadId = null,
}: {
  model: AgentPanelModel;
  activities?: ReadonlyArray<OrchestrationThreadActivity>;
  workspaceRoot?: string | undefined;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
}) {
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(() => new Set());
  const [scriptWorkflowId, setScriptWorkflowId] = useState<string | null>(null);

  const allAgents = useMemo(() => allPanelAgents(model), [model]);
  const openAgent = allAgents.find((agent) => agent.id === openAgentId) ?? null;
  const finished = useMemo(() => finishedAgents(model), [model]);

  const toggleExpanded = (id: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const toggleSection = (key: string, members: ReadonlyArray<RuntimeSubagent>) =>
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
        setExpandedIds((expanded) => expansionsAfterCollapse(expanded, members));
      }
      return next;
    });

  const renderCard = (agent: RuntimeSubagent) => (
    <AgentCard
      key={agent.id}
      agent={agent}
      environmentId={environmentId}
      threadId={threadId}
      activities={activities}
      workspaceRoot={workspaceRoot}
      expanded={expandedIds.has(agent.id)}
      onToggle={() => toggleExpanded(agent.id)}
      onOpen={() => setOpenAgentId(agent.id)}
    />
  );

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

  if (openAgent) {
    return (
      <AgentActivityView
        agent={openAgent}
        environmentId={environmentId}
        threadId={threadId}
        onBack={() => setOpenAgentId(null)}
      />
    );
  }

  const liveDirect = model.directAgents.filter(isLive);

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
        <div className="flex flex-col gap-2.5 p-2.5">
          {model.workflows.map((group) => {
            const scriptPath = group.workflow.runHandles?.scriptPath;
            const canShowScript =
              scriptPath !== undefined && environmentId !== null && threadId !== null;
            return (
              <div key={group.workflow.id} className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2 px-1 pt-0.5">
                  <span className="min-w-0 truncate text-[.8125rem] font-semibold">
                    {group.workflow.workflowName ?? group.workflow.title}
                  </span>
                  {canShowScript ? (
                    <button
                      type="button"
                      onClick={() =>
                        setScriptWorkflowId((current) =>
                          current === group.workflow.id ? null : group.workflow.id,
                        )
                      }
                      aria-expanded={scriptWorkflowId === group.workflow.id}
                      className="ml-auto rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground hover:text-foreground"
                    >
                      {"{}"} script
                    </button>
                  ) : null}
                </div>
                {scriptWorkflowId === group.workflow.id && canShowScript ? (
                  <WorkflowScriptView
                    environmentId={environmentId}
                    threadId={threadId}
                    scriptPath={scriptPath}
                    onClose={() => setScriptWorkflowId(null)}
                  />
                ) : null}
                {group.phases.map((phase) => {
                  const live = phase.members.filter(isLive);
                  if (live.length === 0) return null;
                  const key = `${group.workflow.id}:${phase.index}`;
                  return (
                    <Section
                      key={key}
                      title={phase.title}
                      meta={`${live.length} working`}
                      folded={`${phase.members.length} agents, ${phase.settledCount} done`}
                      open={!collapsedSections.has(key)}
                      onToggle={() => toggleSection(key, phase.members)}
                    >
                      {live.map(renderCard)}
                    </Section>
                  );
                })}
                {group.unphasedMembers.filter(isLive).map(renderCard)}
              </div>
            );
          })}

          {liveDirect.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <div className="px-1 pt-0.5 text-xs text-muted-foreground">
                Spawned directly{" "}
                <span className="font-mono text-[.6875rem]">{liveDirect.length}</span>
              </div>
              {liveDirect.map(renderCard)}
            </div>
          ) : null}

          {finished.length > 0 ? (
            <Section
              title="Finished"
              meta={`${finished.length}`}
              folded={`${finished.length} agents`}
              open={!collapsedSections.has("finished")}
              onToggle={() => toggleSection("finished", finished)}
            >
              {finished.map(renderCard)}
            </Section>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
