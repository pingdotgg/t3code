/**
 * Agent awareness — the one phase deriver.
 *
 * A phase is a *level*: "what is this thread doing right now". Edge detection
 * ("did something notification-worthy just happen") is a different question and
 * lives in the server-side `NotificationReactor`. Keeping the level function
 * pure and shared is what stops every consumer from growing its own state
 * machine, which is the whole bug class this module exists to prevent.
 *
 * @module agentAwareness
 */
import type {
  EnvironmentId,
  NotificationKind,
  NotificationThreadPhase,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Every phase a surface can render. `stale` is presentation-only — the relay
 * marks a published card stale when its updates stop arriving — so the deriver
 * below never returns it and notification rows never record it.
 */
export type AgentAwarenessPhase = NotificationThreadPhase | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  /**
   * Presentation only. `updatedAt` must never reach a notification identity
   * key: it is the last domain-event timestamp, not a write clock.
   */
  readonly updatedAt: string;
  readonly deepLink: string;
}

export type AgentAwarenessThreadShell = Pick<
  OrchestrationThreadShell,
  | "id"
  | "title"
  | "modelSelection"
  | "session"
  | "latestTurn"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
>;

export interface ProjectThreadAwarenessInput {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<OrchestrationProjectShell, "title">;
  readonly thread: AgentAwarenessThreadShell;
}

export function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export function projectThreadAwareness(
  input: ProjectThreadAwarenessInput,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  const phase = resolveThreadAwarenessPhase(thread);
  if (!phase) {
    return null;
  }

  const detail = detailForPhase(phase, thread);
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: thread.updatedAt,
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

/**
 * Priority-ordered phase derivation.
 *
 * The order is load-bearing, and so is its consequence: a thread with both a
 * pending approval and pending input only ever reports `waiting_for_approval`.
 * Edge detectors must therefore read attention from the raw booleans, never from
 * this phase, or one of two simultaneous attentions is silently swallowed.
 */
export function resolveThreadAwarenessPhase(
  thread: AgentAwarenessThreadShell,
): NotificationThreadPhase | null {
  if (thread.hasPendingApprovals) {
    return "waiting_for_approval";
  }
  if (thread.hasPendingUserInput) {
    return "waiting_for_input";
  }
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  if (thread.session?.status === "starting") {
    return "starting";
  }
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return "running";
  }
  if (thread.latestTurn?.state === "completed") {
    return "completed";
  }
  // A turn that finished can still read as "interrupted" here: session
  // teardown settles still-running turns by session status, and that write
  // can race the turn.completed one. completedAt survives the race — a turn
  // that has a completion timestamp finished, whatever the state column says.
  // Without this, quick finish-then-teardown threads resolve to null
  // persistently and get tombstoned instead of published as completed.
  if (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null) {
    return "completed";
  }
  // Threads whose turns never produce a checkpoint (no code changes) have no
  // materialized latestTurn in the shell at all, and the session-set
  // projection clears latest_turn_id the moment the session settles. The
  // session status is then the only surviving completion signal: a live
  // session at "ready"/"idle" with nothing pending and nothing running means
  // the agent finished and is waiting for the next prompt — Done.
  if (thread.session?.status === "ready" || thread.session?.status === "idle") {
    return "completed";
  }
  return null;
}

/**
 * Everything that counts as "the agent is blocked on the user for an approval".
 *
 * Read as raw booleans, never off the phase: `resolveThreadAwarenessPhase` is
 * priority-ordered, and an actionable proposed plan is not one of its inputs at
 * all. The notification reactor and the sidebar's raise-hand predicate share
 * this function so the OS surface and the inbox can never disagree about whether
 * a thread is waiting on the user.
 */
export function threadHasPendingApproval(
  thread: Pick<OrchestrationThreadShell, "hasPendingApprovals" | "hasActionableProposedPlan">,
): boolean {
  return thread.hasPendingApprovals || thread.hasActionableProposedPlan;
}

/**
 * Whether the latest turn traces back to a human prompt, or `null` when there is
 * no turn to classify.
 *
 * Providers surface background and subagent output as synthetic turns with no
 * corresponding user message. Steering can append a later user message to a real
 * turn, so user activity at or after `requestedAt` still counts.
 *
 * Both sides are `IsoDateTime`, so the comparison is a string compare — the same
 * one `ProjectionPipeline` uses to compute `latestUserMessageAt`. No `Date`
 * parsing, and no clock.
 *
 * Never consults the command id: handoff seed turns arrive under
 * `server:handoff-turn-start:*` and are genuinely user-initiated, while other
 * `server:*` families (`server:checkpoint-*`) are not.
 *
 * Shared with the sidebar's raise-hand predicate: a background turn's completion
 * neither notifies nor wakes a snoozed thread.
 */
export function isUserInitiatedTurn(
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "latestUserMessageAt">,
): boolean | null {
  if (thread.latestTurn === null) {
    return null;
  }
  if (thread.latestUserMessageAt === null) {
    return false;
  }
  return thread.latestUserMessageAt >= thread.latestTurn.requestedAt;
}

export function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}

/**
 * Notification copy keys on the *kind*, not the phase.
 *
 * The phase is priority-ordered, so a `user-input-required` edge raised on a
 * thread that also has a pending approval would otherwise be captioned
 * "Approval needed".
 */
export function headlineForNotificationKind(kind: NotificationKind): string {
  switch (kind) {
    case "turn-completed":
      return "Agent finished";
    case "turn-failed":
      return "Agent failed";
    case "approval-required":
      return "Approval needed";
    case "user-input-required":
      return "Waiting for input";
  }
}

export function detailForPhase(
  phase: AgentAwarenessPhase,
  thread: AgentAwarenessThreadShell,
): string | undefined {
  if (phase === "failed") {
    return thread.session?.lastError ?? undefined;
  }
  if (phase === "completed") {
    return "Review the completed task.";
  }
  if (phase === "running" && thread.session?.providerName) {
    return `${thread.session.providerName} is active.`;
  }
  return undefined;
}
