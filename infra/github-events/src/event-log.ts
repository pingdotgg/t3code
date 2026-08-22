import type { GitHubEvent } from "./events.ts";

export interface StoredGitHubEvent extends GitHubEvent {
  readonly sequence: number;
}

export interface EventLogState {
  readonly sequence: number;
  readonly deliveries: ReadonlyArray<string>;
  readonly events: ReadonlyArray<StoredGitHubEvent>;
}

export interface AppendEventResult {
  readonly state: EventLogState;
  readonly duplicate: boolean;
  readonly storedEvent: StoredGitHubEvent | null;
}

const emptyState: EventLogState = {
  sequence: 0,
  deliveries: [],
  events: [],
};

export function appendEvent(
  current: EventLogState | undefined,
  event: GitHubEvent,
  retention: number,
): AppendEventResult {
  const state = current ?? emptyState;
  if (state.deliveries.includes(event.deliveryId)) {
    return { state, duplicate: true, storedEvent: null };
  }

  const storedEvent = { ...event, sequence: state.sequence + 1 };
  return {
    state: {
      sequence: storedEvent.sequence,
      deliveries: [...state.deliveries, event.deliveryId].slice(-retention),
      events: [...state.events, storedEvent].slice(-retention),
    },
    duplicate: false,
    storedEvent,
  };
}

export interface ReadEventsOptions {
  readonly after?: number;
  readonly pullRequestNumber?: number;
}

export interface ReadEventsResult {
  readonly expired: boolean;
  readonly future: boolean;
  readonly earliestSequence: number;
  readonly latestSequence: number;
  readonly events: ReadonlyArray<StoredGitHubEvent>;
}

export type ResumeCursorStatus = "ok" | "expired" | "future";

export function resumeCursorStatus(
  earliestSequence: number | null,
  latestSequence: number,
  after: number | undefined,
): ResumeCursorStatus {
  if (after === undefined) return "ok";
  if (after > latestSequence) return "future";
  if (earliestSequence !== null && after < earliestSequence - 1) return "expired";
  return "ok";
}

export function readEvents(
  state: EventLogState | undefined,
  options: ReadEventsOptions,
): ReadEventsResult {
  const current = state ?? emptyState;
  const earliestSequence = current.events[0]?.sequence ?? current.sequence;
  const after = options.after;
  const cursorStatus = resumeCursorStatus(
    current.events.length > 0 ? earliestSequence : null,
    current.sequence,
    after,
  );
  const expired = cursorStatus === "expired";
  const future = cursorStatus === "future";
  const events =
    expired || future
      ? []
      : current.events.filter(
          (event) =>
            (after === undefined || event.sequence > after) &&
            (options.pullRequestNumber === undefined ||
              event.pullRequestNumbers.includes(options.pullRequestNumber)),
        );
  return {
    expired,
    future,
    earliestSequence,
    latestSequence: current.sequence,
    events,
  };
}
