import type { RuntimeTaskStatus } from "@t3tools/contracts";

/**
 * Pure mapping of Grok Build `x.ai/session_notification` updates onto T3's
 * shared task.* surface. Claude stamps workflow members with parentAgentId +
 * timelineBypass and a stable slot id; Codex does the same for collab
 * children. Grok must not invent a third shape.
 */

export interface GrokWorkflowPhase {
  readonly title: string;
  readonly state: string;
}

export interface GrokWorkflowAgent {
  readonly agentId: string;
  readonly label: string;
  readonly phase: string | undefined;
  readonly model: string | undefined;
  readonly state: string;
  readonly tokensUsed: number;
  readonly durationMs: number;
}

export interface GrokWorkflowUpdated {
  readonly runId: string;
  readonly revision: number;
  readonly name: string;
  readonly objective: string;
  readonly status: string;
  readonly phases: ReadonlyArray<GrokWorkflowPhase>;
  readonly currentPhase: string | undefined;
  readonly agentBudget: number | undefined;
  readonly agentsUsed: number | undefined;
  readonly elapsedMs: number | undefined;
  readonly activeAgents: number | undefined;
  readonly currentAgentLabel: string | undefined;
  readonly agents: ReadonlyArray<GrokWorkflowAgent>;
  readonly pauseMessage: string | undefined;
  readonly resultSummary: string | undefined;
}

export interface GrokSubagentUpdate {
  readonly kind: "spawned" | "progress" | "finished";
  readonly subagentId: string;
  readonly childSessionId: string | undefined;
  readonly parentSessionId: string | undefined;
  readonly role: string | undefined;
  readonly status: string | undefined;
  readonly error: string | undefined;
  readonly tokensUsed: number | undefined;
  readonly durationMs: number | undefined;
  readonly turnCount: number | undefined;
  readonly toolCallCount: number | undefined;
  readonly output: string | undefined;
}

export interface GrokWorkflowTrackState {
  readonly seenRunIds: ReadonlySet<string>;
  readonly completedRunIds: ReadonlySet<string>;
  readonly seenMemberIds: ReadonlySet<string>;
  readonly completedMemberIds: ReadonlySet<string>;
  readonly memberFingerprints: ReadonlyMap<string, string>;
  readonly seenSubagentIds: ReadonlySet<string>;
  readonly completedSubagentIds: ReadonlySet<string>;
}

export function emptyGrokWorkflowTrackState(): GrokWorkflowTrackState {
  return {
    seenRunIds: new Set(),
    completedRunIds: new Set(),
    seenMemberIds: new Set(),
    completedMemberIds: new Set(),
    memberFingerprints: new Map(),
    seenSubagentIds: new Set(),
    completedSubagentIds: new Set(),
  };
}

export interface GrokTaskEventSpec {
  readonly type: "task.started" | "task.progress" | "task.completed";
  readonly payload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function sessionUpdateTag(update: Record<string, unknown>): string | undefined {
  return readString(update.sessionUpdate) ?? readString(update.session_update);
}

function unwrapSessionUpdate(payload: unknown): Record<string, unknown> | undefined {
  const envelope = asRecord(payload);
  return asRecord(envelope?.update) ?? envelope;
}

export function parseXAiWorkflowUpdated(payload: unknown): GrokWorkflowUpdated | undefined {
  const update = unwrapSessionUpdate(payload);
  if (!update) {
    return undefined;
  }
  const tag = sessionUpdateTag(update);
  if (tag !== undefined && tag !== "workflow_updated" && tag !== "WorkflowUpdated") {
    return undefined;
  }
  const runId = readString(update.run_id) ?? readString(update.runId);
  const name = readString(update.name);
  if (runId === undefined || name === undefined) {
    return undefined;
  }
  if (
    tag === undefined &&
    (readString(update.status) === undefined || !Array.isArray(update.phases))
  ) {
    return undefined;
  }
  const phases = Array.isArray(update.phases)
    ? update.phases.flatMap((entry): ReadonlyArray<GrokWorkflowPhase> => {
        const record = asRecord(entry);
        const title = readString(record?.title);
        const state = readString(record?.state);
        return title && state ? [{ title, state }] : [];
      })
    : [];
  const agents = Array.isArray(update.agents)
    ? update.agents.flatMap((entry): ReadonlyArray<GrokWorkflowAgent> => {
        const record = asRecord(entry);
        const agentId = readString(record?.agent_id) ?? readString(record?.agentId);
        const state = readString(record?.state);
        if (agentId === undefined || state === undefined) {
          return [];
        }
        return [
          {
            agentId,
            label: readString(record?.label) ?? agentId,
            phase: readString(record?.phase),
            model: readString(record?.model),
            state,
            tokensUsed: nonNegativeInt(record?.tokens_used ?? record?.tokensUsed) ?? 0,
            durationMs: nonNegativeInt(record?.duration_ms ?? record?.durationMs) ?? 0,
          },
        ];
      })
    : [];
  return {
    runId,
    revision: nonNegativeInt(update.revision) ?? 0,
    name,
    objective: readString(update.objective) ?? "",
    status: readString(update.status) ?? "active",
    phases,
    currentPhase: readString(update.current_phase) ?? readString(update.currentPhase),
    agentBudget: nonNegativeInt(update.agent_budget ?? update.agentBudget),
    agentsUsed: nonNegativeInt(update.agents_used ?? update.agentsUsed),
    elapsedMs: nonNegativeInt(update.elapsed_ms ?? update.elapsedMs),
    activeAgents: nonNegativeInt(update.active_agents ?? update.activeAgents),
    currentAgentLabel:
      readString(update.current_agent_label) ?? readString(update.currentAgentLabel),
    agents,
    pauseMessage: readString(update.pause_message) ?? readString(update.pauseMessage),
    resultSummary: readString(update.result_summary) ?? readString(update.resultSummary),
  };
}

export function parseXAiSubagentUpdate(payload: unknown): GrokSubagentUpdate | undefined {
  const update = unwrapSessionUpdate(payload);
  if (!update) {
    return undefined;
  }
  const tag = sessionUpdateTag(update);
  const kind =
    tag === "subagent_spawned" || tag === "SubagentSpawned"
      ? "spawned"
      : tag === "subagent_progress" || tag === "SubagentProgress"
        ? "progress"
        : tag === "subagent_finished" || tag === "SubagentFinished"
          ? "finished"
          : undefined;
  if (kind === undefined) {
    return undefined;
  }
  const subagentId = readString(update.subagent_id) ?? readString(update.subagentId);
  if (subagentId === undefined) {
    return undefined;
  }
  return {
    kind,
    subagentId,
    childSessionId: readString(update.child_session_id) ?? readString(update.childSessionId),
    parentSessionId: readString(update.parent_session_id) ?? readString(update.parentSessionId),
    role:
      readString(update.subagent_type) ??
      readString(update.subagentType) ??
      readString(update.agent_type) ??
      readString(update.agentType),
    status: readString(update.status),
    error: readString(update.error),
    tokensUsed: nonNegativeInt(update.tokens_used ?? update.tokensUsed),
    durationMs: nonNegativeInt(update.duration_ms ?? update.durationMs),
    turnCount: nonNegativeInt(update.turn_count ?? update.turnCount ?? update.turns),
    toolCallCount: nonNegativeInt(
      update.tool_call_count ?? update.toolCallCount ?? update.tool_calls ?? update.toolCalls,
    ),
    output: readString(update.output),
  };
}

export function grokWorkflowRunStatus(status: string): RuntimeTaskStatus {
  switch (status) {
    case "active":
      return "running";
    case "complete":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "cleared":
      return "cancelled";
    default:
      return "idle";
  }
}

export function grokWorkflowAgentStatus(state: string): RuntimeTaskStatus {
  switch (state) {
    case "queued":
    case "pending":
      return "pending";
    case "running":
    case "start":
      return "running";
    case "done":
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

export function grokWorkflowRunIsTerminal(status: string): boolean {
  return (
    status === "complete" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "cleared"
  );
}

export function grokWorkflowAgentIsTerminal(state: string): boolean {
  return (
    state === "done" ||
    state === "completed" ||
    state === "failed" ||
    state === "error" ||
    state === "cancelled"
  );
}

export function grokWorkflowMemberTaskId(runId: string, index: number): string {
  return `${runId}:wf:${index}`;
}

function memberFingerprint(agent: GrokWorkflowAgent, status: RuntimeTaskStatus): string {
  return [
    status,
    agent.label,
    agent.model ?? "",
    agent.phase ?? "",
    agent.tokensUsed,
    agent.durationMs,
  ].join("\u001f");
}

function runCompletedStatus(status: string): "completed" | "failed" | "stopped" {
  if (status === "failed") return "failed";
  if (status === "complete") return "completed";
  return "stopped";
}

function agentCompletedStatus(state: string): "completed" | "failed" | "stopped" {
  if (state === "failed" || state === "error") return "failed";
  if (state === "cancelled") return "stopped";
  return "completed";
}

export function applyGrokWorkflowUpdate(
  state: GrokWorkflowTrackState,
  update: GrokWorkflowUpdated,
): { readonly state: GrokWorkflowTrackState; readonly events: ReadonlyArray<GrokTaskEventSpec> } {
  const seenRunIds = new Set(state.seenRunIds);
  const completedRunIds = new Set(state.completedRunIds);
  const seenMemberIds = new Set(state.seenMemberIds);
  const completedMemberIds = new Set(state.completedMemberIds);
  const memberFingerprints = new Map(state.memberFingerprints);
  const events: Array<GrokTaskEventSpec> = [];

  const phases = update.phases.map((phase, index) => ({ index, title: phase.title }));
  const currentPhaseIndex = update.currentPhase
    ? update.phases.findIndex((phase) => phase.title === update.currentPhase)
    : -1;
  const runStatus = grokWorkflowRunStatus(update.status);
  const runSeen = seenRunIds.has(update.runId);
  if (!runSeen) {
    seenRunIds.add(update.runId);
    events.push({
      type: "task.started",
      payload: {
        taskId: update.runId,
        description: update.objective || update.name,
        taskType: "local_workflow",
        workflowName: update.name,
        title: update.name,
        ...(phases.length > 0 ? { phases } : {}),
        ...(currentPhaseIndex >= 0 ? { phaseIndex: currentPhaseIndex } : {}),
        ...(update.currentPhase ? { phaseTitle: update.currentPhase } : {}),
        runHandles: { runId: update.runId },
      },
    });
  } else if (!completedRunIds.has(update.runId)) {
    events.push({
      type: "task.progress",
      payload: {
        taskId: update.runId,
        description: update.objective || update.name,
        summary: update.currentAgentLabel ?? update.currentPhase ?? update.status,
        status: runStatus,
        taskType: "local_workflow",
        workflowName: update.name,
        title: update.name,
        ...(phases.length > 0 ? { phases } : {}),
        ...(currentPhaseIndex >= 0 ? { phaseIndex: currentPhaseIndex } : {}),
        ...(update.currentPhase ? { phaseTitle: update.currentPhase } : {}),
        runHandles: { runId: update.runId },
      },
    });
  }

  if (grokWorkflowRunIsTerminal(update.status) && !completedRunIds.has(update.runId)) {
    completedRunIds.add(update.runId);
    events.push({
      type: "task.completed",
      payload: {
        taskId: update.runId,
        status: runCompletedStatus(update.status),
        summary: update.resultSummary ?? update.pauseMessage ?? update.status,
        taskType: "local_workflow",
        workflowName: update.name,
        title: update.name,
        ...(phases.length > 0 ? { phases } : {}),
        runHandles: { runId: update.runId },
      },
    });
  }

  for (const [agentIndex, agent] of update.agents.entries()) {
    const memberId = grokWorkflowMemberTaskId(update.runId, agentIndex);
    const status = grokWorkflowAgentStatus(agent.state);
    const fingerprint = memberFingerprint(agent, status);
    if (memberFingerprints.get(memberId) === fingerprint) {
      continue;
    }
    memberFingerprints.set(memberId, fingerprint);
    const memberSeen = seenMemberIds.has(memberId);
    const linkage = {
      taskId: memberId,
      description: agent.label,
      taskType: "subagent",
      parentAgentId: update.runId,
      title: agent.label,
      workflowName: update.name,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.phase ? { phaseTitle: agent.phase } : {}),
      agentIndex,
      timelineBypass: true,
    };
    if (!memberSeen) {
      seenMemberIds.add(memberId);
      events.push({ type: "task.started", payload: linkage });
    }
    events.push({
      type: "task.progress",
      payload: {
        ...linkage,
        summary: agent.state,
        status,
        ...(agent.tokensUsed > 0 || agent.durationMs > 0
          ? {
              typedUsage: {
                totalTokens: agent.tokensUsed,
                ...(agent.durationMs > 0 ? { durationMs: agent.durationMs } : {}),
              },
            }
          : {}),
      },
    });
    if (grokWorkflowAgentIsTerminal(agent.state) && !completedMemberIds.has(memberId)) {
      completedMemberIds.add(memberId);
      events.push({
        type: "task.completed",
        payload: {
          ...linkage,
          status: agentCompletedStatus(agent.state),
          summary: agent.label,
          ...(agent.tokensUsed > 0 ? { typedUsage: { totalTokens: agent.tokensUsed } } : {}),
        },
      });
    }
  }

  return {
    state: {
      ...state,
      seenRunIds,
      completedRunIds,
      seenMemberIds,
      completedMemberIds,
      memberFingerprints,
    },
    events,
  };
}

export function applyGrokSubagentUpdate(
  state: GrokWorkflowTrackState,
  update: GrokSubagentUpdate,
): { readonly state: GrokWorkflowTrackState; readonly events: ReadonlyArray<GrokTaskEventSpec> } {
  const seenSubagentIds = new Set(state.seenSubagentIds);
  const completedSubagentIds = new Set(state.completedSubagentIds);
  const events: Array<GrokTaskEventSpec> = [];
  const title = update.role ?? update.subagentId;
  const linkage = {
    taskId: update.subagentId,
    description: title,
    title,
    taskType: "subagent",
    role: update.role ?? "general-purpose",
    ...(update.parentSessionId ? { parentAgentId: update.parentSessionId } : {}),
    ...(update.childSessionId ? { agentPath: update.childSessionId } : {}),
    timelineBypass: true,
  };

  if (update.kind === "spawned" && !seenSubagentIds.has(update.subagentId)) {
    seenSubagentIds.add(update.subagentId);
    events.push({ type: "task.started", payload: linkage });
  } else if (update.kind === "progress") {
    if (!seenSubagentIds.has(update.subagentId)) {
      seenSubagentIds.add(update.subagentId);
      events.push({ type: "task.started", payload: linkage });
    }
    if (!completedSubagentIds.has(update.subagentId)) {
      events.push({
        type: "task.progress",
        payload: {
          ...linkage,
          status: "running",
          summary: update.role ?? "running",
          ...(update.tokensUsed !== undefined || update.durationMs !== undefined
            ? {
                typedUsage: {
                  totalTokens: update.tokensUsed ?? 0,
                  ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
                  ...(update.toolCallCount !== undefined ? { toolUses: update.toolCallCount } : {}),
                },
              }
            : {}),
        },
      });
    }
  } else if (update.kind === "finished" && !completedSubagentIds.has(update.subagentId)) {
    if (!seenSubagentIds.has(update.subagentId)) {
      seenSubagentIds.add(update.subagentId);
      events.push({ type: "task.started", payload: linkage });
    }
    completedSubagentIds.add(update.subagentId);
    const finished = update.status ?? "completed";
    events.push({
      type: "task.completed",
      payload: {
        ...linkage,
        status:
          finished === "failed" ? "failed" : finished === "cancelled" ? "stopped" : "completed",
        summary: update.error ?? update.output ?? finished,
        ...(update.tokensUsed !== undefined
          ? { typedUsage: { totalTokens: update.tokensUsed } }
          : {}),
      },
    });
  }

  return {
    state: {
      ...state,
      seenSubagentIds,
      completedSubagentIds,
    },
    events,
  };
}
