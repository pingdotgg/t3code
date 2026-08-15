/**
 * Native-provider subagent observability: a tolerant fold over persisted
 * task.* / tool.* thread activities into orchestration-v2-shaped subagent
 * state, plus the source-neutral panel model every client renders.
 *
 * This module is deliberately legacy-bridge code. When orchestration-v2's
 * subagent projection is available for a thread, deriveAgentPanelModel
 * prefers it (see the v2Projection parameter) and the fold is skipped; when
 * the v1 orchestrator is retired this file is deleted. Field names and
 * transition semantics copy the v2 stack (#4779) exactly so that swap is
 * mechanical.
 *
 * Invariants encoded here trace to shipped bugs in the prior PRs (#4220,
 * #3650, #4662): reusable identity vs one-shot activations, idle as a real
 * nonterminal state, provider-specific usage merges, first-write terminal
 * timestamps, reactivation clearing terminal detail, and order-robust
 * folding (completion can create an agent; a late start only fills
 * metadata).
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface SubagentActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface SubagentWorkflowPhase {
  readonly index: number;
  readonly title: string;
}

export interface SubagentRunHandles {
  readonly runId?: string;
  readonly scriptPath?: string;
  readonly transcriptDir?: string;
  readonly sessionUrl?: string;
}

export interface RuntimeSubagent {
  readonly id: string;
  readonly kind: "subagent" | "workflow" | "workflow_agent";
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly activationCount: number;
  readonly usage: SubagentUsage | null;
  readonly progress: string | null;
  readonly lastToolName: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly outputFile: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<SubagentWorkflowPhase>;
  readonly runHandles: SubagentRunHandles | null;
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  /** First retained observation, used as the roster's stable display order. */
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

const TERMINAL_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Active = the user may still need to care while it runs. Idle is settled-ish
 * but resumable; waiting counts as active because it needs the user. */
export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

const RECENT_ACTIVITY_LIMIT = 6;
const SUMMARY_CHAR_LIMIT = 180;
const ROSTER_LIMIT = 100;

/**
 * True when this activity's payload does NOT belong on the Agents surface.
 * Classification happens exactly once, server-side at ingestion
 * (classifyTaskAgentKind → the persisted agentKind stamp); the client only
 * reads it. Rows without a stamp — legacy threads, pre-stamp servers — are
 * background by definition: they render in the ordinary work log, exactly
 * as they did before this feature existed.
 */
export function isBackgroundTaskActivity(payload: Record<string, unknown>): boolean {
  return payload.agentKind !== "agent";
}

function bounded(value: string): string {
  return value.length <= SUMMARY_CHAR_LIMIT ? value : `${value.slice(0, SUMMARY_CHAR_LIMIT - 1)}…`;
}

/** Appends to the ring buffer, deduping consecutive identical summaries. */
function appendActivity(
  entries: ReadonlyArray<SubagentActivityEntry>,
  at: string,
  summary: string,
): ReadonlyArray<SubagentActivityEntry> {
  const boundedSummary = bounded(summary);
  if (entries.length > 0 && entries[entries.length - 1]?.summary === boundedSummary) {
    return entries;
  }
  const next = [...entries, { at, summary: boundedSummary }];
  return next.length > RECENT_ACTIVITY_LIMIT ? next.slice(-RECENT_ACTIVITY_LIMIT) : next;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asUsage(value: unknown): SubagentUsage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const totalTokens = asCount(record.totalTokens);
  if (totalTokens === undefined) {
    return undefined;
  }
  const usage: {
    totalTokens: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    toolUses?: number;
    durationMs?: number;
  } = { totalTokens };
  const inputTokens = asCount(record.inputTokens);
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  const cachedInputTokens = asCount(record.cachedInputTokens);
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  const outputTokens = asCount(record.outputTokens);
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  const reasoningOutputTokens = asCount(record.reasoningOutputTokens);
  if (reasoningOutputTokens !== undefined) usage.reasoningOutputTokens = reasoningOutputTokens;
  const toolUses = asCount(record.toolUses);
  if (toolUses !== undefined) usage.toolUses = toolUses;
  const durationMs = asCount(record.durationMs);
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return usage;
}

/**
 * Provider-specific usage merge (#4779 semantics, verbatim):
 * - max-merge (Codex-style cumulative frames): field-wise maximum, idempotent
 *   under duplicate or late frames. Cumulative totals never shrink.
 * - accumulate (Claude-style activation deltas): not needed at this layer —
 *   Claude's task_progress usage is itself cumulative per task, so the fold
 *   also max-merges. The distinction matters when v2 sums activations.
 * Field-wise: a terminal payload carrying only totalTokens must not wipe a
 * known breakdown.
 */
function mergeUsageMax(
  current: SubagentUsage | null,
  incoming: SubagentUsage | undefined,
): SubagentUsage | null {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  const pick = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.max(a, b);
  const merged: {
    totalTokens: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    toolUses?: number;
    durationMs?: number;
  } = { totalTokens: Math.max(current.totalTokens, incoming.totalTokens) };
  const inputTokens = pick(current.inputTokens, incoming.inputTokens);
  if (inputTokens !== undefined) merged.inputTokens = inputTokens;
  const cachedInputTokens = pick(current.cachedInputTokens, incoming.cachedInputTokens);
  if (cachedInputTokens !== undefined) merged.cachedInputTokens = cachedInputTokens;
  const outputTokens = pick(current.outputTokens, incoming.outputTokens);
  if (outputTokens !== undefined) merged.outputTokens = outputTokens;
  const reasoningOutputTokens = pick(current.reasoningOutputTokens, incoming.reasoningOutputTokens);
  if (reasoningOutputTokens !== undefined) merged.reasoningOutputTokens = reasoningOutputTokens;
  const toolUses = pick(current.toolUses, incoming.toolUses);
  if (toolUses !== undefined) merged.toolUses = toolUses;
  const durationMs = pick(current.durationMs, incoming.durationMs);
  if (durationMs !== undefined) merged.durationMs = durationMs;
  return merged;
}

interface MutableAgent {
  id: string;
  kind: RuntimeSubagent["kind"];
  title: string;
  role: string | null;
  model: string | null;
  effort: string | null;
  status: RuntimeSubagentStatus;
  activationCount: number;
  usage: SubagentUsage | null;
  progress: string | null;
  lastToolName: string | null;
  result: string | null;
  error: string | null;
  outputFile: string | null;
  parentAgentId: string | null;
  agentIndex: number | null;
  phaseIndex: number | null;
  phaseTitle: string | null;
  attempt: number | null;
  workflowName: string | null;
  phases: ReadonlyArray<SubagentWorkflowPhase>;
  runHandles: SubagentRunHandles | null;
  recentActivity: ReadonlyArray<SubagentActivityEntry>;
  firstSeenAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

function kindFromPayload(
  payload: Record<string, unknown>,
  agentId: string,
): RuntimeSubagent["kind"] {
  if (asString(payload.taskType) === "local_workflow") {
    return "workflow";
  }
  if (payload.parentAgentId !== undefined || agentId.includes(":wf:")) {
    return "workflow_agent";
  }
  return "subagent";
}

/** Completion can create an agent (its start may have aged out of retention). */
function getOrCreate(
  agents: Map<string, MutableAgent>,
  id: string,
  payload: Record<string, unknown>,
  at: string,
): MutableAgent {
  const existing = agents.get(id);
  if (existing) {
    return existing;
  }
  const created: MutableAgent = {
    id,
    kind: kindFromPayload(payload, id),
    title: asString(payload.title) ?? asString(payload.detail) ?? id,
    role: asString(payload.role) ?? null,
    model: asString(payload.model) ?? null,
    effort: asString(payload.effort) ?? null,
    status: "pending",
    activationCount: 0,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: asString(payload.parentAgentId) ?? null,
    agentIndex: asCount(payload.agentIndex) ?? null,
    phaseIndex: asCount(payload.phaseIndex) ?? null,
    phaseTitle: asString(payload.phaseTitle) ?? null,
    attempt: asCount(payload.attempt) ?? null,
    workflowName: asString(payload.workflowName) ?? null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: at,
    startedAt: null,
    completedAt: null,
    updatedAt: at,
  };
  agents.set(id, created);
  return created;
}

/** Metadata fill from any payload: never downgrades known values to null. */
function fillMetadata(agent: MutableAgent, payload: Record<string, unknown>): void {
  const title = asString(payload.title);
  if (title) agent.title = title;
  const role = asString(payload.role);
  if (role) agent.role = role;
  const model = asString(payload.model);
  if (model) agent.model = model;
  const effort = asString(payload.effort);
  if (effort) agent.effort = effort;
  const parentAgentId = asString(payload.parentAgentId);
  if (parentAgentId) {
    agent.parentAgentId = parentAgentId;
    if (agent.kind === "subagent") agent.kind = "workflow_agent";
  }
  const workflowName = asString(payload.workflowName);
  if (workflowName) agent.workflowName = workflowName;
  if (asString(payload.taskType) === "local_workflow") agent.kind = "workflow";
  const agentIndex = asCount(payload.agentIndex);
  if (agentIndex !== undefined) agent.agentIndex = agentIndex;
  const phaseIndex = asCount(payload.phaseIndex);
  if (phaseIndex !== undefined) agent.phaseIndex = phaseIndex;
  const phaseTitle = asString(payload.phaseTitle);
  if (phaseTitle) agent.phaseTitle = phaseTitle;
  const attempt = asCount(payload.attempt);
  if (attempt !== undefined) {
    // A new attempt on a workflow slot is a reactivation of the same
    // identity: clear the previous attempt's terminal detail so the status
    // transition (terminal → running, in applyStatus) reads as a fresh run.
    // The activation bump lives ONLY in applyStatus — bumping here too
    // counted every retry twice (review finding: two attempts read "run 3").
    if (agent.attempt !== null && attempt > agent.attempt) {
      agent.result = null;
      agent.error = null;
      agent.completedAt = null;
    }
    agent.attempt = attempt;
  }
  const outputFile = asString(payload.outputFile);
  if (outputFile) agent.outputFile = outputFile;
  if (Array.isArray(payload.phases)) {
    const phases: SubagentWorkflowPhase[] = [];
    for (const entry of payload.phases) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const index = asCount(record.index);
      const phaseName = asString(record.title);
      if (index !== undefined && phaseName) {
        phases.push({ index, title: phaseName });
      }
    }
    if (phases.length > 0) {
      agent.phases = phases.slice().sort((a, b) => a.index - b.index);
    }
  }
  if (typeof payload.runHandles === "object" && payload.runHandles !== null) {
    const record = payload.runHandles as Record<string, unknown>;
    const runHandles: {
      runId?: string;
      scriptPath?: string;
      transcriptDir?: string;
      sessionUrl?: string;
    } = {};
    const runId = asString(record.runId);
    if (runId) runHandles.runId = runId;
    const scriptPath = asString(record.scriptPath);
    if (scriptPath) runHandles.scriptPath = scriptPath;
    const transcriptDir = asString(record.transcriptDir);
    if (transcriptDir) runHandles.transcriptDir = transcriptDir;
    // Defense-in-depth: the adapter already sanitizes, but payloads are not
    // schema-validated on the read path (shipped XSS lesson).
    const sessionUrl = asString(record.sessionUrl);
    if (sessionUrl && /^https?:\/\//i.test(sessionUrl)) runHandles.sessionUrl = sessionUrl;
    if (Object.keys(runHandles).length > 0) {
      agent.runHandles = { ...agent.runHandles, ...runHandles };
    }
  }
}

function applyStatus(agent: MutableAgent, status: RuntimeSubagentStatus, at: string): void {
  const wasTerminal = isTerminalSubagentStatus(agent.status);
  const isTerminal = isTerminalSubagentStatus(status);
  if (wasTerminal && isTerminal) {
    // Duplicate terminal events are idempotent: first write wins, timestamps
    // don't slide.
    return;
  }
  if ((wasTerminal || agent.status === "idle") && (status === "running" || status === "pending")) {
    // Reactivation: same identity, new run. Clear the previous run's terminal
    // detail so a live card never shows the prior run's output.
    agent.activationCount += 1;
    agent.result = null;
    agent.error = null;
    agent.completedAt = null;
    if (status === "running") {
      agent.startedAt = at;
    }
  }
  if (status === "running" && agent.startedAt === null) {
    agent.startedAt = at;
  }
  if (isTerminal && agent.completedAt === null) {
    agent.completedAt = at;
  }
  agent.status = status;
}

// Map, not object literal: payloads aren't schema-validated on the read
// path, so a status like "toString" must miss instead of resolving an
// inherited Function through the prototype chain.
const TASK_COMPLETED_STATUS: ReadonlyMap<string, RuntimeSubagentStatus> = new Map([
  ["completed", "completed"],
  ["failed", "failed"],
  ["stopped", "interrupted"],
]);

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function asRuntimeStatus(value: unknown): RuntimeSubagentStatus | undefined {
  return typeof value === "string" && KNOWN_STATUSES.has(value)
    ? (value as RuntimeSubagentStatus)
    : undefined;
}

/**
 * Folds a thread's persisted activities into subagent state. Tolerant by
 * construction: malformed rows are skipped individually; unknown kinds are
 * ignored. Pure — memoize by activity-list identity at the atom layer.
 *
 * sessionLive=false derives interruption: background tasks die with their
 * provider session, so agents whose terminal rows were lost (server
 * restart, crash) must not read as running forever (review finding: a dead
 * session left a panel full of "Working" agents while the sidebar showed
 * nothing). Idle is preserved — a resumable Codex child stays resumable.
 */
export function foldSubagentActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: { readonly sessionLive?: boolean },
): ReadonlyArray<RuntimeSubagent> {
  const agents = new Map<string, MutableAgent>();

  for (const activity of activities) {
    if (typeof activity.payload !== "object" || activity.payload === null) {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    const at = activity.createdAt;

    switch (activity.kind) {
      case "task.started": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        // Only real agents join the roster. Shells, monitors, and plan-mode
        // tasks are background work — they render in the ordinary work log,
        // not the Agents surface (a "Run 12s stall" shell is not a subagent).
        if (isBackgroundTaskActivity(payload)) break;
        const agent = getOrCreate(agents, taskId, payload, at);
        fillMetadata(agent, payload);
        // Order-robustness: a start row arriving after a terminal state is a
        // late/out-of-order delivery and only fills metadata — it must not
        // reopen the run. Reactivation comes exclusively from explicit
        // status transitions (task.updated / progress status). Guard on the
        // status itself, not activationCount: a task first seen via a
        // terminal task.updated has zero activations but is still settled
        // (review finding: a late start reopened a failed child).
        if (agent.activationCount === 0 && !isTerminalSubagentStatus(agent.status)) {
          agent.activationCount = 1;
          agent.startedAt = agent.startedAt ?? at;
          agent.status = "running";
        } else if (agent.status === "idle") {
          applyStatus(agent, "running", at);
        }
        const detail = asString(payload.detail);
        if (detail && agent.title === agent.id) agent.title = detail;
        agent.updatedAt = at;
        break;
      }
      case "task.progress": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        // Membership is sticky per taskId: rows after the first (terminal
        // rows often carry only taskId+status, no marker fields) inherit the
        // first row's classification instead of being re-judged.
        const existed = agents.has(taskId);
        if (!existed && isBackgroundTaskActivity(payload)) break;
        const agent = getOrCreate(agents, taskId, payload, at);
        fillMetadata(agent, payload);
        if (agent.activationCount === 0) agent.activationCount = 1;
        const explicitStatus = asRuntimeStatus(payload.status);
        if (explicitStatus) {
          applyStatus(agent, explicitStatus, at);
        } else if (
          (payload.usageSnapshot !== true || !existed) &&
          !isTerminalSubagentStatus(agent.status) &&
          agent.status !== "idle"
        ) {
          applyStatus(agent, "running", at);
        }
        const summary = asString(payload.summary);
        if (summary) {
          agent.progress = bounded(summary);
          agent.recentActivity = appendActivity(agent.recentActivity, at, summary);
        }
        const lastToolName = asString(payload.lastToolName);
        if (lastToolName) {
          agent.lastToolName = lastToolName;
          if (!summary) {
            agent.recentActivity = appendActivity(agent.recentActivity, at, `▸ ${lastToolName}`);
          }
        }
        const error = asString(payload.error);
        if (error) agent.error = bounded(error);
        agent.usage = mergeUsageMax(agent.usage, asUsage(payload.typedUsage));
        agent.updatedAt = at;
        break;
      }
      case "task.updated": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        // Membership is sticky per taskId: rows after the first (terminal
        // rows often carry only taskId+status, no marker fields) inherit the
        // first row's classification instead of being re-judged.
        if (!agents.has(taskId) && isBackgroundTaskActivity(payload)) break;
        const agent = getOrCreate(agents, taskId, payload, at);
        fillMetadata(agent, payload);
        // A task first seen via task.updated (start row aged out) has run at
        // least once — zero activations would misreport "run 0" and let a
        // later start row treat it as never-started (review finding).
        if (agent.activationCount === 0) agent.activationCount = 1;
        const wasTerminal = isTerminalSubagentStatus(agent.status);
        const status = asRuntimeStatus(payload.status);
        if (status) applyStatus(agent, status, at);
        const error = asString(payload.error);
        if (error) agent.error = bounded(error);
        // Provider end time beats ingestion time for the transition that
        // actually settled the run (applyStatus fills completedAt with the
        // activity timestamp first, so check the transition, not null).
        const endedAt = asString(payload.endedAt);
        if (endedAt && !wasTerminal && isTerminalSubagentStatus(agent.status)) {
          agent.completedAt = endedAt;
        }
        agent.updatedAt = at;
        break;
      }
      case "task.completed": {
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        // Membership is sticky per taskId: rows after the first (terminal
        // rows often carry only taskId+status, no marker fields) inherit the
        // first row's classification instead of being re-judged.
        if (!agents.has(taskId) && isBackgroundTaskActivity(payload)) break;
        const agent = getOrCreate(agents, taskId, payload, at);
        fillMetadata(agent, payload);
        if (agent.activationCount === 0) agent.activationCount = 1;
        // Already-terminal: status and timestamps are frozen (first write
        // wins, duplicates must not slide them) but the completion still
        // ENRICHES — Claude commonly emits terminal task.updated before
        // task.completed, and the completion carries the result summary and
        // final usage the update lacked (review finding: the early return
        // dropped both). Fill-if-missing keeps duplicate completions from
        // replacing the first result.
        const summary = asString(payload.summary) ?? asString(payload.detail);
        if (isTerminalSubagentStatus(agent.status)) {
          if (summary) {
            if (agent.status === "failed") {
              agent.error = agent.error ?? bounded(summary);
            } else {
              agent.result = agent.result ?? bounded(summary);
            }
          }
          agent.usage = mergeUsageMax(agent.usage, asUsage(payload.typedUsage));
          break;
        }
        const status = TASK_COMPLETED_STATUS.get(asString(payload.status) ?? "") ?? "completed";
        applyStatus(agent, status, at);
        if (summary) {
          if (status === "failed") {
            agent.error = agent.error ?? bounded(summary);
          } else {
            agent.result = bounded(summary);
          }
        }
        agent.usage = mergeUsageMax(agent.usage, asUsage(payload.typedUsage));
        agent.updatedAt = at;
        break;
      }
      case "tool.progress": {
        // Agent-owned heartbeat: "what it's doing right now".
        const taskId = asString(payload.taskId);
        if (!taskId) break;
        const agent = agents.get(taskId);
        if (!agent) break;
        const toolName = asString(payload.toolName);
        if (toolName) {
          agent.lastToolName = toolName;
          agent.recentActivity = appendActivity(agent.recentActivity, at, `▸ ${toolName}`);
        }
        agent.updatedAt = at;
        break;
      }
      default:
        break;
    }
  }

  // Consistency pass: when a workflow coordinator has settled, members that
  // never received their own terminal row cannot still be in-flight — the
  // run is over. Cascade the coordinator's outcome so stalled member rows
  // don't read as working forever (live-test finding: statuses drifted
  // whenever member terminal rows were lost or never emitted).
  for (const agent of agents.values()) {
    if (agent.kind !== "workflow" || !isTerminalSubagentStatus(agent.status)) {
      continue;
    }
    for (const member of agents.values()) {
      if (member.parentAgentId !== agent.id) {
        continue;
      }
      if (isTerminalSubagentStatus(member.status) || member.status === "idle") {
        continue;
      }
      member.status = agent.status === "completed" ? "completed" : "interrupted";
      member.completedAt = member.completedAt ?? agent.completedAt ?? agent.updatedAt;
      member.updatedAt = agent.updatedAt;
    }
  }

  // Session death orphans every live agent: no process remains to finish
  // them. Mirrors the server-side liveness registry clearing on
  // session.exited, so panel and sidebar can never disagree.
  if (options?.sessionLive === false) {
    for (const agent of agents.values()) {
      if (isActiveSubagentStatus(agent.status)) {
        agent.status = "interrupted";
        agent.completedAt = agent.completedAt ?? agent.updatedAt;
      }
    }
  }

  let roster = Array.from(agents.values());
  if (roster.length > ROSTER_LIMIT) {
    // Prefer live, then waiting/idle, then newest settled.
    const rank = (agent: MutableAgent): number =>
      isActiveSubagentStatus(agent.status) ? 0 : agent.status === "idle" ? 1 : 2;
    roster = roster
      .slice()
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, ROSTER_LIMIT);
  }

  return roster.map((agent) => ({ ...agent }));
}

export interface AgentPanelWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<RuntimeSubagent>;
    /** done = every member settled (success or error); running = any active. */
    readonly state: "pending" | "running" | "done";
    readonly activeCount: number;
    readonly settledCount: number;
  }>;
  /** Members with no resolvable phase (orphans render under the workflow). */
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
}

export interface AgentPanelModel {
  readonly workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly idleCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
  readonly hasAgents: boolean;
  readonly liveCount: number;
}

const EMPTY_PANEL_MODEL: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0,
};

export function emptyAgentPanelModel(): AgentPanelModel {
  return EMPTY_PANEL_MODEL;
}

/**
 * Source-neutral view model. When the orchestration-v2 subagent projection
 * exists for the thread, pass it as v2Projection and it wins outright — the
 * two sources are never merged (duplicate-agents failure mode). Until v2
 * lands, callers pass null and the native fold output is used.
 */
export function deriveAgentPanelModel({
  agents,
  v2Projection,
}: {
  readonly agents: ReadonlyArray<RuntimeSubagent>;
  readonly v2Projection?: ReadonlyArray<RuntimeSubagent> | null;
}): AgentPanelModel {
  const source = v2Projection ?? agents;
  if (source.length === 0) {
    return EMPTY_PANEL_MODEL;
  }

  const workflows = source
    .filter((agent) => agent.kind === "workflow")
    .slice()
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, RuntimeSubagent[]>();
  const direct: RuntimeSubagent[] = [];

  for (const agent of source) {
    if (agent.kind === "workflow") {
      continue;
    }
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    } else {
      // Orphaned members (coordinator aged out) fall back to the direct list.
      direct.push(agent);
    }
  }

  const workflowGroups: AgentPanelWorkflowGroup[] = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
    const knownPhases =
      workflow.phases.length > 0
        ? workflow.phases
        : (() => {
            const derived = new Map<number, string>();
            for (const member of workflowMembers) {
              if (member.phaseIndex !== null && !derived.has(member.phaseIndex)) {
                derived.set(
                  member.phaseIndex,
                  member.phaseTitle ?? `Phase ${member.phaseIndex + 1}`,
                );
              }
            }
            return Array.from(derived.entries())
              .map(([index, title]) => ({ index, title }))
              .slice()
              .sort((a, b) => a.index - b.index);
          })();

    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .slice()
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const activeCount = phaseMembers.filter(
        // Idle members count as active for phase-liveness: a resumable Codex
        // member has not finished the phase.
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      ).length;
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0
          ? "pending"
          : activeCount > 0
            ? "running"
            : settledCount === phaseMembers.length
              ? "done"
              : "pending";
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state,
        activeCount,
        settledCount,
      };
    });

    // Unknown phase indices land here too — a member must never vanish just
    // because its phase row was lost (review finding).
    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null || !knownPhaseIndices.has(member.phaseIndex))
      .slice()
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));

    return { workflow, phases, unphasedMembers };
  });

  let runningCount = 0;
  let waitingCount = 0;
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of source) {
    // A workflow coordinator with members is a container for those members, not
    // work of its own: it reports running for the whole run and aggregates their
    // usage upstream in some providers. Counting it would report one more agent
    // working than there are, and double count tokens.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }

  return {
    workflows: workflowGroups,
    // Updates and the >100-agent retention ranking must never reshuffle rows
    // that remain visible.
    directAgents: direct
      .slice()
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id)),
    runningCount,
    waitingCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount,
  };
}

/**
 * Members ordered by urgency for the capped inline workflow card: running and
 * failed first, then waiting, then most recently updated.
 */
export function workflowCardMembers(
  group: AgentPanelWorkflowGroup,
  limit: number,
): { readonly visible: ReadonlyArray<RuntimeSubagent>; readonly overflow: number } {
  const all = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  const urgency = (agent: RuntimeSubagent): number => {
    if (agent.status === "failed") return 0;
    if (agent.status === "running") return 1;
    if (agent.status === "waiting") return 2;
    return 3;
  };
  const ordered = all
    .slice()
    .sort((a, b) => urgency(a) - urgency(b) || b.updatedAt.localeCompare(a.updatedAt));
  return {
    visible: ordered.slice(0, limit),
    overflow: Math.max(0, ordered.length - limit),
  };
}

/** Kinds the timeline should not render as generic rows (fold input only). */
export function isSubagentActivityKind(kind: string): boolean {
  return (
    kind === "task.started" ||
    kind === "task.progress" ||
    kind === "task.updated" ||
    kind === "task.completed" ||
    kind === "tool.progress"
  );
}

/**
 * Quiet-timeline guarantee: tool rows attributed to an owning agent belong in
 * the Agents surface, not the parent chat. Unattributed rows must stay.
 */
export function isAgentAttributedToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (typeof activity.payload !== "object" || activity.payload === null) {
    return false;
  }
  const payload = activity.payload as Record<string, unknown>;
  return typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
}

/** Timeline-bypassing synthesized rows (Codex children, workflow members). */
export function isTimelineBypassActivity(activity: OrchestrationThreadActivity): boolean {
  if (typeof activity.payload !== "object" || activity.payload === null) {
    return false;
  }
  return (activity.payload as Record<string, unknown>).timelineBypass === true;
}

/**
 * Compact model chip text: strips vendor prefixes/date-or-context suffixes
 * ("claude-sonnet-5[1m]" → "sonnet-5[1m]", "claude-opus-4-20250514" →
 * "opus-4"). Unknown ids pass through untouched; effort appends as "· high".
 */
export function formatSubagentModelLabel(
  model: string | null,
  effort: string | null,
): string | null {
  if (!model) {
    return null;
  }
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

export function formatSubagentTokenCount(totalTokens: number): string {
  if (totalTokens < 1000) {
    return `${totalTokens}`;
  }
  if (totalTokens < 1_000_000) {
    const value = totalTokens / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}
