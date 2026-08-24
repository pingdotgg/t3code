/**
 * Read-only conversation surface for one native subagent. The right-panel
 * workspace owns tab selection; this component only resolves and renders the
 * selected agent so inactive tabs stay as lightweight descriptors.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
  SubagentTranscriptEntry,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import {
  Bot,
  Braces,
  Check,
  ChevronDown,
  FilePenLine,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { AssistantReasoningBlock } from "~/components/chat/AssistantReasoningBlock";
import { shouldPreserveAssistantLineBreaks } from "~/components/chat/MessagesTimeline.logic";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useI18n } from "~/i18n";
import type { MessageKey } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";

const EMPTY_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

const STATUS_VISUALS: Record<
  RuntimeSubagent["status"],
  { dotClass: string; labelKey: MessageKey }
> = {
  pending: { dotClass: "bg-info", labelKey: "agents.status.working" },
  running: { dotClass: "bg-info", labelKey: "agents.status.working" },
  waiting: { dotClass: "bg-info", labelKey: "agents.status.working" },
  idle: { dotClass: "bg-muted-foreground/50", labelKey: "agents.status.idleResumable" },
  completed: { dotClass: "bg-success", labelKey: "agents.status.completed" },
  failed: { dotClass: "bg-destructive", labelKey: "agents.status.failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", labelKey: "agents.status.stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", labelKey: "agents.status.stopped" },
};

export interface AgentPanelEntry {
  readonly agent: RuntimeSubagent;
  readonly workflow: AgentPanelWorkflowGroup | null;
}

export interface AgentPanelViewState {
  scrollTop: number | null;
  followsLiveEdge: boolean;
  scriptOpen: boolean;
  readonly expandedToolEntryIds: Set<string>;
  readonly reasoningOpenByEntryId: Map<string, boolean>;
  readonly reasoningStreamingByEntryId: Map<string, boolean>;
}

export function createAgentPanelViewState(): AgentPanelViewState {
  return {
    scrollTop: null,
    followsLiveEdge: true,
    scriptOpen: false,
    expandedToolEntryIds: new Set(),
    reasoningOpenByEntryId: new Map(),
    reasoningStreamingByEntryId: new Map(),
  };
}

/** Stable tab order: workflow members by phase, then unphased and direct agents. */
export function listAgentPanelEntries(model: AgentPanelModel): ReadonlyArray<AgentPanelEntry> {
  const entries: AgentPanelEntry[] = [];
  const seen = new Set<string>();
  const append = (agent: RuntimeSubagent, workflow: AgentPanelWorkflowGroup | null) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    entries.push({ agent, workflow });
  };

  for (const workflow of model.workflows) {
    for (const phase of workflow.phases) {
      for (const member of phase.members) append(member, workflow);
    }
    for (const member of workflow.unphasedMembers) append(member, workflow);
  }
  for (const agent of model.directAgents) append(agent, null);
  return entries;
}

/** Coordinators are diagnostic-only surfaces; they never replace member tabs. */
export function findAgentPanelEntry(
  model: AgentPanelModel,
  agentId: string,
): AgentPanelEntry | null {
  const worker = listAgentPanelEntries(model).find((entry) => entry.agent.id === agentId);
  if (worker) return worker;
  const workflow = model.workflows.find((entry) => entry.workflow.id === agentId);
  return workflow ? { agent: workflow.workflow, workflow } : null;
}

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  return formatElapsedSeconds((end - start) / 1000);
}

/** Live elapsed time updates the text node without committing the transcript. */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) return;
    const update = () => {
      if (textRef.current) textRef.current.textContent = elapsedBetween(startedAt, null);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) return null;
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) return agent.progress ?? agent.lastToolName ?? agent.result ?? agent.error;
  return agent.error ?? agent.result ?? agent.progress ?? agent.lastToolName;
}

function transcriptToolIcon(itemType: string | null) {
  if (itemType === "command_execution") return Terminal;
  if (itemType === "file_change") return FilePenLine;
  if (itemType === "web_search") return Search;
  return Wrench;
}

function AgentToolActivityRow({
  entry,
  viewState,
}: {
  entry: SubagentTranscriptEntry;
  viewState: AgentPanelViewState;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => viewState.expandedToolEntryIds.has(entry.id));
  const failed = entry.status === "failed" || entry.status === "declined";
  const working = entry.status === "inProgress";
  const canExpand = Boolean(entry.text?.trim());
  const Icon = failed ? X : transcriptToolIcon(entry.itemType);
  const label = entry.label ?? entry.itemType ?? t("agents.transcript.tool");
  const statusLabel = failed
    ? t("agents.status.failed")
    : working
      ? t("agents.status.working")
      : entry.status === "completed"
        ? t("agents.status.completed")
        : null;
  const toggle = () => {
    if (!canExpand) return;
    setExpanded((value) => {
      const next = !value;
      if (next) viewState.expandedToolEntryIds.add(entry.id);
      else viewState.expandedToolEntryIds.delete(entry.id);
      return next;
    });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canExpand || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggle();
  };
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": failed ? `${label}: ${t("chat.toolFailed")}` : label,
        "aria-expanded": expanded,
        onClick: toggle,
        onKeyDown: handleKeyDown,
      }
    : {};

  return (
    <div className="pb-2" data-agent-transcript-kind="tool">
      <div
        className={cn(
          "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
          canExpand &&
            "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
        {...rowToggleProps}
      >
        <div className="flex select-none items-center gap-1.5">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center",
              failed ? "text-destructive" : "text-icon-muted",
            )}
            role={failed ? "img" : undefined}
            aria-label={failed ? t("chat.toolFailed") : undefined}
          >
            <Icon aria-hidden className="block size-4 shrink-0 stroke-[1.8] opacity-70" />
          </span>
          <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                failed ? "font-medium text-destructive" : "text-secondary-label",
              )}
            >
              {label}
            </span>
            {working ? (
              <span className="shrink-0 text-xs text-muted-foreground">{statusLabel}</span>
            ) : null}
            {statusLabel && !working ? <span className="sr-only">{statusLabel}</span> : null}
          </p>
          {canExpand ? (
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          ) : null}
        </div>
        {expanded && entry.text ? (
          <div
            className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-[length:var(--font-size-code,0.6875rem)] leading-relaxed select-text">
              {entry.text}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const AgentTranscriptEntry = memo(function AgentTranscriptEntry({
  entry,
  cwd,
  threadRef,
  skills,
  viewState,
}: {
  entry: SubagentTranscriptEntry;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  viewState: AgentPanelViewState;
}) {
  if (entry.kind === "tool") return <AgentToolActivityRow entry={entry} viewState={viewState} />;

  if (entry.kind === "reasoning") {
    if (!entry.text) return null;
    const streaming = entry.status === "inProgress";
    const previousStreaming = viewState.reasoningStreamingByEntryId.get(entry.id);
    if (previousStreaming !== undefined && previousStreaming !== streaming) {
      viewState.reasoningOpenByEntryId.set(entry.id, streaming);
    }
    viewState.reasoningStreamingByEntryId.set(entry.id, streaming);
    return (
      <div className="pb-2" data-agent-transcript-kind="reasoning">
        <AssistantReasoningBlock
          text={entry.text}
          streaming={streaming}
          markdownCwd={cwd}
          threadRef={threadRef}
          skills={skills}
          initialOpen={viewState.reasoningOpenByEntryId.get(entry.id) ?? streaming}
          onOpenChange={(open) => viewState.reasoningOpenByEntryId.set(entry.id, open)}
        />
      </div>
    );
  }

  if (!entry.text) return null;
  return (
    <div
      className={cn("group/assistant", entry.phase === "commentary" ? "pb-2" : "pb-4")}
      data-agent-transcript-kind="assistant"
      data-agent-message-phase={entry.phase ?? undefined}
    >
      <div className="relative min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={entry.text}
          cwd={cwd}
          threadRef={threadRef}
          lineBreaks={shouldPreserveAssistantLineBreaks(entry.text)}
          isStreaming={entry.status === "inProgress"}
          skills={skills}
        />
      </div>
    </div>
  );
});

function useTranscriptAutoScroll(agent: RuntimeSubagent | null, viewState: AgentPanelViewState) {
  const rootRef = useRef<HTMLDivElement>(null);
  const followsLiveEdgeRef = useRef(true);
  const transcriptVersion = agent
    ? `${agent.id}:${agent.transcript.length}:${agent.transcript.at(-1)?.updatedAt ?? ""}`
    : "missing";

  useEffect(() => {
    followsLiveEdgeRef.current = viewState.followsLiveEdge;
    const viewport = rootRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    let restored = false;
    const updateFollowState = () => {
      if (!restored) return;
      followsLiveEdgeRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
      viewState.followsLiveEdge = followsLiveEdgeRef.current;
      viewState.scrollTop = viewport.scrollTop;
    };
    const frame = requestAnimationFrame(() => {
      if (viewState.followsLiveEdge) viewport.scrollTop = viewport.scrollHeight;
      else if (viewState.scrollTop !== null) viewport.scrollTop = viewState.scrollTop;
      restored = true;
      updateFollowState();
    });
    viewport.addEventListener("scroll", updateFollowState, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      if (restored) updateFollowState();
      viewport.removeEventListener("scroll", updateFollowState);
    };
  }, [agent?.id, viewState]);

  useEffect(() => {
    if (!followsLiveEdgeRef.current) return;
    const frame = requestAnimationFrame(() => {
      const viewport = rootRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
        viewState.scrollTop = viewport.scrollTop;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [transcriptVersion, viewState]);

  return rootRef;
}

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
  const { t } = useI18n();
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-3 mt-3 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label={t("agents.script.close")}
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? `\n${t("agents.script.truncated")}` : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">{t("agents.script.loadFailed")}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("agents.script.loading")}</p>
        )}
      </div>
    </div>
  );
}

function AgentHeader({
  entry,
  canShowScript,
  scriptOpen,
  onToggleScript,
}: {
  entry: AgentPanelEntry;
  canShowScript: boolean;
  scriptOpen: boolean;
  onToggleScript: () => void;
}) {
  const { t } = useI18n();
  const { agent, workflow } = entry;
  const visuals = STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const workflowName = workflow?.workflow.workflowName ?? workflow?.workflow.title ?? null;
  const metadata = [
    role,
    workflowName,
    agent.phaseTitle,
    formatSubagentModelLabel(agent.model, agent.effort),
    t("agents.tokens.short", {
      count: agent.usage ? formatSubagentTokenCount(agent.usage.totalTokens) : "—",
    }),
    agent.usage?.toolUses !== undefined
      ? t("agents.tools.count", { count: agent.usage.toolUses })
      : null,
    agent.activationCount > 1 ? t("agents.run.count", { count: agent.activationCount }) : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <header className="shrink-0 border-b border-border/60 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={agent.status} />
        <h2 className="min-w-0 truncate text-sm font-medium">{agent.title}</h2>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <AgentElapsed agent={agent} />
          <span>{t(visuals.labelKey)}</span>
          {agent.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
        </span>
        {canShowScript ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-micro"
                  variant={scriptOpen ? "secondary" : "ghost-muted"}
                  onClick={onToggleScript}
                  aria-label={t("agents.script.open")}
                  aria-expanded={scriptOpen}
                />
              }
            >
              <Braces aria-hidden className="size-3" />
            </TooltipTrigger>
            <TooltipPopup>{t("agents.script.open")}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {activity ? (
        <p
          className={cn(
            "mt-1 truncate text-xs",
            agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {activity}
        </p>
      ) : null}
      <p className="mt-1 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </p>
    </header>
  );
}

export function AgentsPanel({
  model,
  agentId,
  environmentId = null,
  threadId = null,
  cwd,
  skills = EMPTY_SKILLS,
  viewState: providedViewState,
}: {
  model: AgentPanelModel;
  agentId: string;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  cwd?: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  viewState?: AgentPanelViewState;
}) {
  const { t } = useI18n();
  const internalViewState = useRef<AgentPanelViewState>(createAgentPanelViewState());
  const viewState = providedViewState ?? internalViewState.current;
  const entry = useMemo(() => findAgentPanelEntry(model, agentId), [agentId, model]);
  const agent = entry?.agent ?? null;
  const threadRef = useMemo<ScopedThreadRef | undefined>(
    () => (environmentId !== null && threadId !== null ? { environmentId, threadId } : undefined),
    [environmentId, threadId],
  );
  const [scriptOpen, setScriptOpen] = useState(viewState.scriptOpen);
  useEffect(() => setScriptOpen(viewState.scriptOpen), [agentId, viewState]);
  const setPersistedScriptOpen = (open: boolean) => {
    viewState.scriptOpen = open;
    setScriptOpen(open);
  };
  const transcriptScrollRef = useTranscriptAutoScroll(agent, viewState);
  const scriptPath =
    entry?.workflow?.workflow.runHandles?.scriptPath ?? agent?.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;

  if (!entry) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">{t("agents.transcript.unavailable")}</p>
      </div>
    );
  }
  const selectedAgent = entry.agent;

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={entry.agent.title}>
      <AgentHeader
        entry={entry}
        canShowScript={canShowScript}
        scriptOpen={scriptOpen}
        onToggleScript={() => setPersistedScriptOpen(!scriptOpen)}
      />
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setPersistedScriptOpen(false)}
        />
      ) : null}
      <ScrollArea ref={transcriptScrollRef} className="min-h-0 flex-1" scrollFade>
        {selectedAgent.transcript.length > 0 ? (
          <div
            role="region"
            aria-label={t("agents.transcript.label", { title: selectedAgent.title })}
            className="mx-auto flex w-full max-w-3xl flex-col px-3 py-4 sm:px-5"
          >
            {selectedAgent.transcript.map((transcriptEntry) => (
              <AgentTranscriptEntry
                key={transcriptEntry.id}
                entry={transcriptEntry}
                cwd={cwd}
                threadRef={threadRef}
                skills={skills}
                viewState={viewState}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {agentActivityText(selectedAgent) ?? t(STATUS_VISUALS[selectedAgent.status].labelKey)}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}
