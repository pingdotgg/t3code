import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * `ThreadAgentSnapshot` — one delegated worker (subagent, workflow, workflow
 * agent, background shell, monitor) observed on a thread.
 *
 * The snapshot models a stable *identity* with rollups across its activations:
 * a Codex collab agent is a durable, re-activatable child thread (follow-ups
 * re-run it), while a Claude task is a one-shot execution. `status: "idle"`
 * captures the Codex "finished a run but resumable" state, which is distinct
 * from the terminal `completed`.
 *
 * Transport: the full per-thread roster is carried latest-wins in the payload
 * of an `agent.snapshot` thread activity (see `ThreadAgentsActivityPayload`).
 * There is no dedicated wire event — the activity channel's open `kind` string
 * and unknown payload are the compatibility surface, mirroring how
 * `context-window.updated` ships token snapshots today.
 */
export const ThreadAgentStatus = Schema.Literals([
  // Not yet running (workflow agent queued behind a phase, Codex pendingInit).
  "pending",
  "running",
  // Blocked on an approval or user-input request.
  "waiting",
  // Finished a run but resumable (Codex agents between activations; Claude paused).
  "idle",
  "completed",
  "failed",
  "stopped",
]);
export type ThreadAgentStatus = typeof ThreadAgentStatus.Type;

export const THREAD_AGENT_TERMINAL_STATUSES: ReadonlySet<ThreadAgentStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export const ThreadAgentKind = Schema.Literals([
  "subagent",
  "workflow",
  "workflow_agent",
  "shell",
  "monitor",
  "other",
]);
export type ThreadAgentKind = typeof ThreadAgentKind.Type;

/** Cumulative usage across all of an agent's activations. */
export const ThreadAgentUsage = Schema.Struct({
  totalTokens: NonNegativeInt,
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
});
export type ThreadAgentUsage = typeof ThreadAgentUsage.Type;

export const ThreadAgentActivityEntry = Schema.Struct({
  at: IsoDateTime,
  summary: TrimmedNonEmptyString,
});
export type ThreadAgentActivityEntry = typeof ThreadAgentActivityEntry.Type;

/** Ordered workflow phase, present only on `kind: "workflow"` snapshots. */
export const ThreadAgentWorkflowPhase = Schema.Struct({
  index: NonNegativeInt,
  title: TrimmedNonEmptyString,
});
export type ThreadAgentWorkflowPhase = typeof ThreadAgentWorkflowPhase.Type;

export const THREAD_AGENT_RECENT_ACTIVITY_LIMIT = 6;

export const ThreadAgentSnapshot = Schema.Struct({
  // Stable identity: Claude task_id, Codex child thread id. Provider
  // discriminates the id space so cross-provider collisions are impossible.
  agentId: TrimmedNonEmptyString,
  provider: ProviderDriverKind,
  kind: ThreadAgentKind,
  name: TrimmedNonEmptyString,
  // Provider agent type: Claude subagent_type ("Explore"), Codex agent_role
  // ("explorer").
  agentType: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  status: ThreadAgentStatus,
  currentActivity: Schema.optional(TrimmedNonEmptyString),
  lastToolName: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(ThreadAgentUsage),
  firstStartedAt: IsoDateTime,
  // Start of the CURRENT activation. Live elapsed timers derive from this so
  // idle gaps between resumptions don't inflate the display; absent on
  // pre-field snapshots (clients fall back to firstStartedAt).
  lastStartedAt: Schema.optional(IsoDateTime),
  lastActivityAt: IsoDateTime,
  // Cleared when a re-activation (Codex follow-up) starts a new run.
  endedAt: Schema.optional(IsoDateTime),
  // Codex follow-ups and Claude workflow retry attempts.
  activationCount: NonNegativeInt,
  spawnTurnId: Schema.optional(TurnId),
  lastTurnId: Schema.optional(TurnId),
  parentAgentId: Schema.optional(TrimmedNonEmptyString),
  // Workflow phase membership. Index is authoritative; title is display-only
  // (titles can repeat across phases).
  phaseIndex: Schema.optional(NonNegativeInt),
  phaseTitle: Schema.optional(TrimmedNonEmptyString),
  // kind === "workflow" only.
  phases: Schema.optional(Schema.Array(ThreadAgentWorkflowPhase)),
  scriptPath: Schema.optional(TrimmedNonEmptyString),
  runId: Schema.optional(TrimmedNonEmptyString),
  // Reserved for the approval deep-link milestone; no emitter populates it yet.
  approvalRequestId: Schema.optional(ApprovalRequestId),
  // Claude transcript/output path; reserved for the transcript drill-in milestone.
  outputFile: Schema.optional(TrimmedNonEmptyString),
  resultSummary: Schema.optional(TrimmedNonEmptyString),
  errorMessage: Schema.optional(TrimmedNonEmptyString),
  recentActivity: Schema.Array(ThreadAgentActivityEntry),
  // Staleness watermark: how fresh this record is, independent of transport
  // state. Clients compare against their sync watermark.
  updatedAt: IsoDateTime,
});
export type ThreadAgentSnapshot = typeof ThreadAgentSnapshot.Type;

export const THREAD_AGENTS_ACTIVITY_KIND = "agent.snapshot";

/**
 * Payload of an `agent.snapshot` thread activity: the complete latest-wins
 * roster for the thread. Decoded tolerantly on the client — a row that fails
 * to decode is ignored, never fatal.
 */
export const ThreadAgentsActivityPayload = Schema.Struct({
  agents: Schema.Array(ThreadAgentSnapshot),
  // Monotonic per-thread revision: latest-wins selection uses the highest
  // revision (not list position), making same-timestamp appends deterministic.
  revision: Schema.optional(NonNegativeInt),
});
export type ThreadAgentsActivityPayload = typeof ThreadAgentsActivityPayload.Type;
