/**
 * Most-recently-used thread order for `thread.cycleRecent`, the Ctrl+Tab
 * switcher. Visits are recorded from the route; the list is session-only and
 * never persisted. Pressing the shortcut steps one thread further back in
 * visit order. While a walk is in progress the order is frozen and the thread
 * landed on is remembered by key, so holding the modifier and pressing again
 * keeps moving back instead of bouncing between the two newest threads, and a
 * thread vanishing mid-walk cannot shift the position. Ending the walk
 * promotes the landed thread to most recent.
 */

const THREAD_RECENCY_LIMIT = 50;

export interface ThreadRecencyState {
  /** Scoped thread keys, most recent first. */
  readonly history: readonly string[];
  /** Thread landed on mid-walk; null when idle. */
  readonly walkKey: string | null;
}

export const EMPTY_THREAD_RECENCY_STATE: ThreadRecencyState = { history: [], walkKey: null };

function moveToFront(history: readonly string[], threadKey: string): readonly string[] {
  if (history[0] === threadKey) return history;
  return [threadKey, ...history.filter((key) => key !== threadKey)].slice(0, THREAD_RECENCY_LIMIT);
}

export function recordThreadVisit(
  state: ThreadRecencyState,
  threadKey: string | null,
): ThreadRecencyState {
  if (threadKey === null || state.walkKey !== null) return state;
  const history = moveToFront(state.history, threadKey);
  return history === state.history ? state : { history, walkKey: null };
}

export function cycleRecentThread(
  state: ThreadRecencyState,
  input: {
    currentThreadKey: string | null;
    isKnownThread: (threadKey: string) => boolean;
  },
): { state: ThreadRecencyState; target: string | null } {
  const { currentThreadKey, isKnownThread } = input;
  let history: readonly string[] = state.history.filter(
    (key) => key === currentThreadKey || isKnownThread(key),
  );
  if (state.walkKey === null && currentThreadKey !== null) {
    history = moveToFront(history, currentThreadKey);
  }
  if (history.length < 2) {
    return { state: { history, walkKey: null }, target: null };
  }
  const fromIndex = state.walkKey === null ? 0 : Math.max(history.indexOf(state.walkKey), 0);
  const target = history[(fromIndex + 1) % history.length] ?? null;
  return { state: { history, walkKey: target }, target };
}

export function endThreadRecencyWalk(state: ThreadRecencyState): ThreadRecencyState {
  if (state.walkKey === null) return state;
  return { history: moveToFront(state.history, state.walkKey), walkKey: null };
}

export function isModifierKeyName(key: string): boolean {
  switch (key) {
    case "Control":
    case "Meta":
    case "OS":
    case "Command":
    case "Alt":
    case "Option":
    case "Shift":
      return true;
    default:
      return false;
  }
}
