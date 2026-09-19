/**
 * App-switcher-style thread switching: hold the traversal chord's modifier, tap
 * its key to walk a most-recently-used list, release the modifier to commit.
 * Recency is what makes a single tap bounce between the two threads you are
 * actually working in, which position in the sidebar cannot do — that list
 * reorders itself as threads settle and wake.
 */

export type ThreadSwitcherHoldModifier = "metaKey" | "ctrlKey" | "altKey";

export interface ThreadSwitcherModifierState {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/** Visit history kept per session, capped so a long day stays cheap to walk. */
export const THREAD_SWITCHER_HISTORY_LIMIT = 24;

/**
 * Threads offered in one switch. Reaching further back is the command palette's
 * job; an overlay long enough to scroll stops being a switcher.
 */
export const THREAD_SWITCHER_ENTRY_LIMIT = 10;

/**
 * The modifier whose release commits the selection. Shift is deliberately not a
 * candidate: it is what separates the two traversal directions, so letting go of
 * it mid-cycle means "turn around", not "commit". Without any of these held
 * there is nothing to release, and the caller navigates immediately instead.
 */
export function resolveThreadSwitcherHoldModifier(
  state: ThreadSwitcherModifierState,
): ThreadSwitcherHoldModifier | null {
  if (state.metaKey) return "metaKey";
  if (state.ctrlKey) return "ctrlKey";
  if (state.altKey) return "altKey";
  return null;
}

/** Whether a keyup for this key ends the hold that opened the switcher. */
export function isThreadSwitcherHoldModifierKey(
  key: string,
  holdModifier: ThreadSwitcherHoldModifier,
): boolean {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return holdModifier === "metaKey";
    case "Control":
      return holdModifier === "ctrlKey";
    case "Alt":
    case "Option":
      return holdModifier === "altKey";
    default:
      return false;
  }
}

export function recordThreadSwitcherVisit(
  history: readonly string[],
  threadKey: string,
): readonly string[] {
  if (history[0] === threadKey) return history;
  return [threadKey, ...history.filter((key) => key !== threadKey)].slice(
    0,
    THREAD_SWITCHER_HISTORY_LIMIT,
  );
}

/**
 * The thread you are in, then the rest by how recently you had them open, then
 * anything never visited in sidebar order. Threads that have left the sidebar
 * drop out, so a deleted or archived thread is never offered.
 */
export function resolveThreadSwitcherOrder(input: {
  threadKeys: readonly string[];
  history: readonly string[];
  activeThreadKey: string | null;
}): readonly string[] {
  const remaining = new Set(input.threadKeys);
  const order: string[] = [];
  const take = (threadKey: string) => {
    if (order.length >= THREAD_SWITCHER_ENTRY_LIMIT) return;
    if (remaining.delete(threadKey)) order.push(threadKey);
  };

  if (input.activeThreadKey !== null) take(input.activeThreadKey);
  for (const threadKey of input.history) take(threadKey);
  for (const threadKey of input.threadKeys) take(threadKey);
  return order;
}

export function advanceThreadSwitcherIndex(input: {
  index: number;
  count: number;
  direction: "next" | "previous";
}): number {
  if (input.count <= 0) return 0;
  const step = input.direction === "next" ? 1 : -1;
  return (((input.index + step) % input.count) + input.count) % input.count;
}

export interface ThreadSwitcherEntry {
  readonly threadKey: string;
  /** Null once the thread no longer exists, for example deleted mid-switch. */
  readonly title: string | null;
  readonly subtitle: string | null;
}

/**
 * One entry per key in the switch's snapshot, in the same order, so the row
 * the overlay highlights is always the thread that releasing opens. A thread
 * that stops existing mid-switch keeps its row, marked removed, rather than
 * dropping out and shifting every row below it off its index.
 */
export function resolveThreadSwitcherEntries(
  threadKeys: readonly string[],
  describe: (
    threadKey: string,
  ) => { readonly title: string; readonly subtitle: string | null } | null,
): readonly ThreadSwitcherEntry[] {
  return threadKeys.map((threadKey) => {
    const description = describe(threadKey);
    return {
      threadKey,
      title: description?.title ?? null,
      subtitle: description?.subtitle ?? null,
    };
  });
}
