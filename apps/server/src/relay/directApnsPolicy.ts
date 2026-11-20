// Ported from infra/relay/src/agentActivity/agentActivityAlerts.ts and
// agentActivityPayloads.ts. The relay decides on aggregates it receives from
// every environment; this server only sees its own threads, so the decision is
// per thread phase transition instead.
import type { ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";

export interface DirectApnsPreferences {
  readonly notificationsEnabled: boolean;
  readonly notifyOnApproval: boolean;
  readonly notifyOnInput: boolean;
  readonly notifyOnCompletion: boolean;
  readonly notifyOnFailure: boolean;
}

export interface DirectApnsNotification {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
  readonly phase: string;
  readonly updatedAt: string;
}

type Phase = AgentAwarenessPhase;

export const DIRECT_APNS_TERMINAL_FRESHNESS_MS = 2 * 60 * 1_000;

const MAX_TEXT_LENGTH = 120;
const MAX_DEEP_LINK_LENGTH = 512;

const isAttentionPhase = (phase: Phase) =>
  phase === "waiting_for_approval" || phase === "waiting_for_input";
const isTerminalPhase = (phase: Phase) => phase === "completed" || phase === "failed";

function allowedByPreferences(preferences: DirectApnsPreferences, phase: Phase): boolean {
  if (!preferences.notificationsEnabled) return false;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

/**
 * Remembers each thread's last observed phase. The first observation of a
 * thread is a replay (server restart, catch-up), never a transition that
 * should buzz a phone, so it reports `previous: undefined`.
 */
export function makePhaseTracker() {
  const phases = new Map<ThreadId, Phase>();
  return {
    observe(
      threadId: ThreadId,
      state: AgentAwarenessState | null,
    ): { readonly previous: Phase | undefined } {
      const previous = phases.get(threadId);
      // A thread whose activity projects to nothing (settled, interrupted) keeps its last
      // phase, so a re-projected terminal state is not mistaken for a new completion.
      if (state !== null) phases.set(threadId, state.phase);
      return { previous };
    },
    /** Records a startup baseline without overriding anything an event already observed. */
    seed(threadId: ThreadId, state: AgentAwarenessState | null): void {
      if (state !== null && !phases.has(threadId)) phases.set(threadId, state.phase);
    },
    forget(threadId: ThreadId): void {
      phases.delete(threadId);
    },
  };
}

export function alertForTransition(input: {
  readonly previous: Phase | undefined;
  readonly state: AgentAwarenessState;
  readonly preferences: DirectApnsPreferences;
  readonly nowMs: number;
}): boolean {
  const { previous, state } = input;
  if (previous === undefined || previous === state.phase) return false;
  if (!allowedByPreferences(input.preferences, state.phase)) return false;
  if (isAttentionPhase(state.phase)) return !isAttentionPhase(previous);
  if (!isTerminalPhase(state.phase) || isTerminalPhase(previous)) return false;
  const updatedAtMs = Date.parse(state.updatedAt);
  return (
    Number.isFinite(updatedAtMs) && input.nowMs - updatedAtMs <= DIRECT_APNS_TERMINAL_FRESHNESS_MS
  );
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength - 3).trimEnd() + "...";
}

// Only in-app thread paths are routable by the mobile client.
function sanitizeDeepLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  return truncateText(trimmed, MAX_DEEP_LINK_LENGTH);
}

// Same short status words as infra/relay's statusForPhase, so a push reads the
// same whether the relay or this server sent it.
function statusForPhase(phase: Phase): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

export function notificationForState(state: AgentAwarenessState): DirectApnsNotification {
  return {
    title: truncateText(state.threadTitle, MAX_TEXT_LENGTH),
    body: truncateText(`${statusForPhase(state.phase)}: ${state.projectTitle}`, MAX_TEXT_LENGTH),
    environmentId: state.environmentId,
    threadId: state.threadId,
    deepLink: sanitizeDeepLink(state.deepLink),
    phase: state.phase,
    updatedAt: state.updatedAt,
  };
}

export interface DirectLiveActivityRow {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

// Mirrors the widget's AgentActivityProps in apps/mobile/src/widgets/AgentActivity.tsx.
export interface DirectLiveActivityContent {
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<DirectLiveActivityRow>;
}

const MAX_LIVE_ACTIVITY_ROWS = 5;

// Same display rules as the relay's makeAggregateState (infra/relay/src/agentActivity),
// applied to this server's threads only, so a card reads the same from either sender.
const CARD_TERMINAL_TTL_MS = 15 * 60 * 1_000;
const CARD_RUNNING_TTL_MS = 2 * 60 * 60 * 1_000;
const CARD_WAITING_TTL_MS = 24 * 60 * 60 * 1_000;

const attentionPriority = (phase: Phase) => {
  if (isAttentionPhase(phase)) return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
};

const updatedAtMsOf = (state: AgentAwarenessState) => Date.parse(state.updatedAt);

/**
 * The card shows this environment's in-flight threads plus recently finished
 * ones. An environment that died mid-run never reports a terminal state, so
 * in-flight rows expire. Null means nothing is worth showing and a running
 * card should end.
 */
export function liveActivityContentForStates(
  states: Iterable<AgentAwarenessState>,
  nowMs: number,
): DirectLiveActivityContent | null {
  const all = [...states];
  const active = all
    .filter((state) => {
      if (isTerminalPhase(state.phase)) return false;
      const ttl =
        state.phase === "running" || state.phase === "starting"
          ? CARD_RUNNING_TTL_MS
          : CARD_WAITING_TTL_MS;
      return nowMs <= updatedAtMsOf(state) + ttl;
    })
    .toSorted((a, b) => attentionPriority(a.phase) - attentionPriority(b.phase));
  const recentTerminal = all
    .filter(
      (state) =>
        isTerminalPhase(state.phase) && nowMs - updatedAtMsOf(state) <= CARD_TERMINAL_TTL_MS,
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = [...active, ...recentTerminal].slice(0, MAX_LIVE_ACTIVITY_ROWS);
  if (shown.length === 0) return null;
  const subtitle =
    active.length > 0
      ? "Agent work in progress"
      : recentTerminal[0]!.phase === "failed"
        ? "Agent work failed"
        : "Agent work completed";
  return {
    title: "T3 Code",
    subtitle,
    activeCount: active.length,
    updatedAt: [...active, ...recentTerminal].reduce((latest, state) =>
      state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
    ).updatedAt,
    activities: shown.map((state) => ({
      environmentId: state.environmentId,
      threadId: state.threadId,
      projectTitle: truncateText(state.projectTitle, MAX_TEXT_LENGTH),
      threadTitle: truncateText(state.threadTitle, MAX_TEXT_LENGTH),
      modelTitle: truncateText(state.modelTitle, MAX_TEXT_LENGTH),
      phase: state.phase,
      status: statusForPhase(state.phase),
      updatedAt: state.updatedAt,
      deepLink: sanitizeDeepLink(state.deepLink),
    })),
  };
}
