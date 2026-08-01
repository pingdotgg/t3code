import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type ThreadNotificationKind =
  | "completed"
  | "failed"
  | "approval-required"
  | "user-input-required";

export interface ThreadNotificationEvent {
  readonly id: string;
  readonly kind: ThreadNotificationKind;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly occurredAt: string;
}

interface ThreadNotificationObservation {
  readonly completionKey: string | null;
  readonly failureKey: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

export interface ThreadNotificationState {
  readonly seeded: boolean;
  readonly observations: ReadonlyMap<string, ThreadNotificationObservation>;
  readonly emittedEventIds: ReadonlySet<string>;
}

export interface ThreadNotificationReduction {
  readonly state: ThreadNotificationState;
  readonly events: ReadonlyArray<ThreadNotificationEvent>;
}

function threadKey(thread: EnvironmentThreadShell): string {
  return `${thread.environmentId}:${thread.id}`;
}

function turnCompletionKey(thread: EnvironmentThreadShell): string | null {
  return thread.latestTurn?.state === "completed" ? String(thread.latestTurn.turnId) : null;
}

function turnFailureKey(thread: EnvironmentThreadShell): string | null {
  if (thread.latestTurn?.state === "error") {
    return `turn:${thread.latestTurn.turnId}`;
  }
  if (thread.session?.status === "error") {
    return `session:${thread.session.updatedAt}`;
  }
  return null;
}

function observe(thread: EnvironmentThreadShell): ThreadNotificationObservation {
  return {
    completionKey: turnCompletionKey(thread),
    failureKey: turnFailureKey(thread),
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
  };
}

function event(
  thread: EnvironmentThreadShell,
  kind: ThreadNotificationKind,
  identity: string,
  occurredAt: string,
): ThreadNotificationEvent {
  return {
    id: `${threadKey(thread)}:${kind === "failed" ? "failed" : kind}:${identity}`,
    kind,
    environmentId: thread.environmentId,
    threadId: thread.id,
    threadTitle: thread.title,
    occurredAt,
  };
}

function transitionEvent(
  previous: ThreadNotificationObservation,
  thread: EnvironmentThreadShell,
  current: ThreadNotificationObservation,
): ThreadNotificationEvent | null {
  // Attention outranks terminal status. If one snapshot carries both, the
  // user needs the actionable alert rather than two notifications for one edge.
  if (current.hasPendingUserInput && !previous.hasPendingUserInput) {
    return event(thread, "user-input-required", thread.updatedAt, thread.updatedAt);
  }
  if (current.hasPendingApprovals && !previous.hasPendingApprovals) {
    return event(thread, "approval-required", thread.updatedAt, thread.updatedAt);
  }
  if (current.failureKey !== null && current.failureKey !== previous.failureKey) {
    const identity = current.failureKey.startsWith("turn:")
      ? current.failureKey.slice("turn:".length)
      : current.failureKey;
    return event(
      thread,
      "failed",
      identity,
      thread.latestTurn?.completedAt ?? thread.session?.updatedAt ?? thread.updatedAt,
    );
  }
  if (current.completionKey !== null && current.completionKey !== previous.completionKey) {
    return event(
      thread,
      "completed",
      current.completionKey,
      thread.latestTurn?.completedAt ?? thread.updatedAt,
    );
  }
  return null;
}

const EMPTY_OBSERVATION: ThreadNotificationObservation = {
  completionKey: null,
  failureKey: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

const MAX_EMITTED_EVENT_IDS = 512;

function rememberEventId(eventIds: Set<string>, eventId: string): void {
  if (eventIds.has(eventId)) {
    return;
  }
  if (eventIds.size >= MAX_EMITTED_EVENT_IDS) {
    const oldest = eventIds.values().next().value;
    if (oldest !== undefined) {
      eventIds.delete(oldest);
    }
  }
  eventIds.add(eventId);
}

export function createThreadNotificationState(
  emittedEventIds: Iterable<string> = [],
): ThreadNotificationState {
  const boundedEventIds = new Set<string>();
  for (const eventId of emittedEventIds) {
    rememberEventId(boundedEventIds, eventId);
  }
  return { seeded: false, observations: new Map(), emittedEventIds: boundedEventIds };
}

export function reduceThreadNotifications(
  state: ThreadNotificationState,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadNotificationReduction {
  const observations = new Map<string, ThreadNotificationObservation>();
  const emittedEventIds = new Set(state.emittedEventIds);
  const events: ThreadNotificationEvent[] = [];

  for (const thread of threads) {
    const key = threadKey(thread);
    const current = observe(thread);
    observations.set(key, current);
    if (!state.seeded) {
      const existingEvent = transitionEvent(EMPTY_OBSERVATION, thread, current);
      if (existingEvent !== null) {
        rememberEventId(emittedEventIds, existingEvent.id);
      }
      continue;
    }
    const previous = state.observations.get(key);
    if (previous === undefined) {
      continue;
    }
    const nextEvent = transitionEvent(previous, thread, current);
    if (nextEvent !== null && !emittedEventIds.has(nextEvent.id)) {
      events.push(nextEvent);
      rememberEventId(emittedEventIds, nextEvent.id);
    }
  }

  return {
    state: { seeded: true, observations, emittedEventIds },
    events,
  };
}
