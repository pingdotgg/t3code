import { effectiveSnoozed, type ThreadSnoozeShell } from "./threadSettled.ts";

// Shared across hook instances so sidebar, header and menu actions invalidate each other.
const currentActions = new Map<string, symbol>();
const listeners = new Set<() => void>();

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

export function begin(kind: string, threadKey: string) {
  const key = JSON.stringify([kind, threadKey]);
  const token = Symbol();
  currentActions.set(key, token);
  notify();
  const isCurrent = () => currentActions.get(key) === token;
  return {
    isCurrent,
    finish: () => {
      if (isCurrent()) {
        currentActions.delete(key);
        notify();
      }
    },
  };
}

export function invalidate(kind: string, threadKey: string) {
  currentActions.delete(JSON.stringify([kind, threadKey]));
  notify();
}

export type ThreadUndoStep =
  | { readonly action: "unsettle"; readonly restoreUnsettledAt?: string | null }
  | { readonly action: "unsnooze" }
  | { readonly action: "pin"; readonly orderKey?: string }
  | { readonly action: "reorderActive"; readonly orderKey: string }
  /** A null wake time restores a snooze that lasts until the thread is woken. */
  | { readonly action: "snooze"; readonly snoozedUntil: string | null };

export type ThreadUndoPlan = readonly [ThreadUndoStep, ...ThreadUndoStep[]];

export function planThreadUndo(
  action: "settle" | "snooze" | "unpin",
  thread?:
    | (ThreadSnoozeShell & {
        readonly pinnedAt?: string | null;
        readonly pinOrderKey?: string | null;
        readonly activeOrderKey?: string | null;
        readonly unsettledAt?: string | null;
      })
    | null,
  // @effect-diagnostics-next-line globalDate:off
  now = new Date().toISOString(),
): ThreadUndoPlan {
  if (action === "snooze") return [{ action: "unsnooze" }];
  const pin: ThreadUndoStep = {
    action: "pin",
    ...(thread?.pinOrderKey != null ? { orderKey: thread.pinOrderKey } : {}),
  };
  // Pinning clears snooze on the server; restore it after restoring pin placement. A snooze a
  // question or failure already woke stays woken, or the restore would hide the thread again.
  const snooze =
    thread != null && effectiveSnoozed(thread, { now })
      ? [{ action: "snooze" as const, snoozedUntil: thread.snoozedUntil ?? null }]
      : [];
  if (action === "unpin") return [pin, ...snooze];
  // Settling clears a manual active position; pinned threads are placed by their pin instead.
  const placement: ThreadUndoStep[] =
    thread?.pinnedAt != null
      ? [pin]
      : thread?.activeOrderKey != null
        ? [{ action: "reorderActive", orderKey: thread.activeOrderKey }]
        : [];
  const unsettle: ThreadUndoStep =
    thread == null
      ? { action: "unsettle" }
      : { action: "unsettle", restoreUnsettledAt: thread.unsettledAt ?? null };
  return [unsettle, ...placement, ...snooze];
}

export async function executeThreadUndo<Result>(
  plan: ThreadUndoPlan,
  execute: (step: ThreadUndoStep) => Promise<Result>,
  succeeded: (result: Result) => boolean,
): Promise<Result> {
  let result = await execute(plan[0]);
  for (const step of plan.slice(1)) {
    if (!succeeded(result)) return result;
    // A snooze can expire before Undo runs, and the server rejects an expired restore.
    if (
      step.action === "snooze" &&
      step.snoozedUntil !== null &&
      // @effect-diagnostics-next-line globalDate:off
      Date.parse(step.snoozedUntil) <= Date.now()
    )
      continue;
    result = await execute(step);
  }
  return result;
}
