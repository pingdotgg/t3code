// @effect-diagnostics globalTimers:off - Shelf placement timers run in web and native clients, outside an Effect runtime.
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type InboxSendSortInput = InboxThreadInput &
  Pick<
    EnvironmentThreadShell,
    "latestUserMessageAt" | "latestUserAuthoredMessageAt" | "latestRunCompletedAt"
  >;

/**
 * Newest first by the last message the user sent. Agent activity never moves
 * a row; creating, un-settling, or (with the Working section) a return does.
 * Pass `observedReturnAt` only with the Working section on.
 */
export function sortInboxThreadsBySend<T extends InboxSendSortInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestUserMessageAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
        // With the Working section, runs mark returns; the stored times survive reloads.
        ...(observedReturnAt === undefined
          ? []
          : [
              toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
              toSortableTimestamp(thread.latestRunCompletedAt ?? undefined) ?? 0,
            ]),
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

type TrackedInboxThread = WorkingThreadInput &
  InboxThreadInput &
  Partial<
    Pick<
      EnvironmentThreadShell,
      | "archivedAt"
      | "deletedAt"
      | "pinnedAt"
      | "settledOverride"
      | "settledAt"
      | "snoozedAt"
      | "snoozedUntil"
      | "activeOrderKey"
      | "pendingGuestMessageCount"
    >
  >;

type ThreadKeyInput = Pick<EnvironmentThreadShell, "environmentId" | "id">;

/**
 * How long a thread that stopped working keeps reading as working. An orchestrator
 * run can end moments before its continuation starts, so clients wait this long
 * before treating the thread as done.
 */
export const WORKING_EXIT_GRACE_MS = 2_000;

/**
 * Keep one at module scope so placement survives routes that unmount the list. Call
 * `observe` when the shells or the snapshot version change, or with null while the beta
 * is off. Its result stays fixed, so a list built from it can be cached.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: ThreadKeyInput) => `${thread.environmentId}:${thread.id}`;
  const states = new Map<
    string,
    { working: boolean; deadline: number | null; placement: string }
  >();
  const returns = new Map<string, number>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  const now = () => {
    // @effect-diagnostics-next-line globalDate:off - The grace deadline is wall-clock time shared by web and native clients.
    return Date.now();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    let next = Infinity;
    for (const state of states.values()) {
      if (state.deadline !== null) next = Math.min(next, state.deadline);
    }
    if (next === Infinity) return;
    timer = setTimeout(
      () => {
        const at = now();
        for (const [key, state] of states) {
          if (state.deadline !== null && state.deadline <= at) {
            state.working = false;
            state.deadline = null;
            returns.set(key, at);
          }
        }
        schedule();
        version++;
        for (const listener of listeners) listener();
      },
      Math.max(0, next - now()),
    );
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
    observe(threads: readonly TrackedInboxThread[] | null): {
      readonly isWorking: (thread: WorkingThreadInput & ThreadKeyInput) => boolean;
      readonly returnedAt: (thread: ThreadKeyInput) => number | undefined;
    } {
      if (threads === null) {
        clearTimeout(timer);
        timer = undefined;
        states.clear();
        returns.clear();
        return { isWorking: isThreadWorking, returnedAt: () => undefined };
      }
      const present = new Set<string>();
      const at = now();
      // @effect-diagnostics-next-line globalDate:off - Snooze checks compare wall-clock ISO times.
      const observedAt = new Date(at).toISOString();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        const placement = JSON.stringify([
          thread.archivedAt,
          thread.deletedAt,
          thread.pinnedAt,
          thread.settledOverride,
          thread.settledAt,
          thread.snoozedAt,
          thread.snoozedUntil,
          thread.activeOrderKey,
        ]);
        const previous = states.get(key);
        const actionable =
          thread.hasPendingApprovals ||
          thread.hasPendingUserInput ||
          thread.pendingSubagentRequest != null ||
          (thread.pendingGuestMessageCount ?? 0) > 0 ||
          (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) ||
          thread.runtime?.lastError != null ||
          thread.latestRun?.status === "failed";
        const moved = previous !== undefined && previous.placement !== placement;
        const excluded =
          thread.archivedAt != null ||
          thread.deletedAt != null ||
          thread.pinnedAt != null ||
          thread.settledOverride === "settled" ||
          effectiveSnoozed(thread, { now: observedAt });
        const actual = isThreadWorking(thread);
        // Only shelf placement is held: execution state and attention requests stay authoritative.
        const deadline =
          !actual && previous?.working && !actionable && !moved && !excluded
            ? (previous.deadline ?? at + WORKING_EXIT_GRACE_MS)
            : null;
        const working = actual || (deadline !== null && deadline > at);
        if (previous?.working && !working) returns.set(key, at);
        states.set(key, { working, deadline: working ? deadline : null, placement });
      }
      for (const key of states.keys()) {
        if (!present.has(key)) {
          states.delete(key);
          returns.delete(key);
        }
      }
      schedule();
      const observedWorking = new Map([...states].map(([key, state]) => [key, state.working]));
      const observedReturns = new Map(returns);
      return {
        isWorking: (thread) => observedWorking.get(keyOf(thread)) ?? isThreadWorking(thread),
        returnedAt: (thread) => observedReturns.get(keyOf(thread)),
      };
    },
    isWorking: (thread: WorkingThreadInput & ThreadKeyInput) =>
      states.get(keyOf(thread))?.working ?? isThreadWorking(thread),
    returnedAt: (thread: ThreadKeyInput) => returns.get(keyOf(thread)),
  };
}
