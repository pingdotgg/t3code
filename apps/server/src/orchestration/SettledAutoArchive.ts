// Pure policy for automatic archiving of settled threads.
//
// A settled thread hides from the inbox but still exists; after
// `autoArchiveSettledAfterDays` (global setting, 1-90, default 2, null means
// never) with no new activity, the settled-auto-archive reactor archives it.
// `thread.archive` cascades to the whole subtree, so the sweep and the
// admission guard both require every active member of the subtree to be a due
// candidate — a root-only check would let archiving a settled parent kill an
// active descendant's session.
import {
  CommandId,
  DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";

import { threadHasPendingInteraction, threadHasQueuedTurnStart } from "./commandInvariants.ts";
import { collectActiveThreadSubtree } from "./threadHierarchy.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

// `thread.unsettled` projects `settledAt` back to null, so any new activity
// restarts the clock from the next settle.
export function normalizeSettledAutoArchiveAfterDays(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS;
}

// Server-side mirror of `effectiveSnoozed`/`threadRaisedHandWhileSnoozed` in
// `packages/client-runtime/src/state/threadSettled.ts`: a future `snoozedUntil`
// suppresses auto-archive unless the thread raised its hand while snoozed
// (pending approval/input, a session error after snoozing, or a turn that
// completed after snoozing). The client shell's approval/input booleans map to
// `threadHasPendingInteraction` here.
function threadRaisedHandWhileSnoozed(thread: OrchestrationThread): boolean {
  const snoozedAt = (thread.snoozedAt ?? null) as string | null;
  if (threadHasPendingInteraction(thread)) return true;
  if (
    thread.session?.status === "error" &&
    (snoozedAt === null || Date.parse(thread.session.updatedAt) > Date.parse(snoozedAt))
  ) {
    return true;
  }
  return (
    snoozedAt !== null &&
    thread.latestTurn?.state === "completed" &&
    thread.latestTurn.completedAt !== null &&
    Date.parse(thread.latestTurn.completedAt) > Date.parse(snoozedAt)
  );
}

function isEffectivelySnoozed(thread: OrchestrationThread, now: string): boolean {
  const snoozedUntil = (thread.snoozedUntil ?? null) as string | null;
  if (snoozedUntil === null || snoozedUntil === undefined) return false;
  const wakeAtMs = Date.parse(snoozedUntil);
  return (
    Number.isFinite(wakeAtMs) && wakeAtMs > Date.parse(now) && !threadRaisedHandWhileSnoozed(thread)
  );
}

// Structural candidacy only — no clock check. The sweep adds the due check
// (`resolveSettledAutoArchiveDue`) and the admission guard re-runs this plus
// the due check against a fresh read model.
export function isSettledAutoArchiveCandidate(thread: OrchestrationThread, now: string): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
  if ((thread.settledOverride ?? null) !== "settled") return false;
  const settledAt = (thread.settledAt ?? null) as string | null;
  if (settledAt === null || !Number.isFinite(Date.parse(settledAt))) return false;
  if ((thread.pinnedAt ?? null) !== null) return false;
  if (isEffectivelySnoozed(thread, now)) return false;
  if (threadHasPendingInteraction(thread)) return false;
  const sessionStatus = thread.session?.status ?? null;
  if (sessionStatus === "starting" || sessionStatus === "running" || sessionStatus === "error") {
    return false;
  }
  // Belt and braces alongside the session check: a running turn without a live
  // session record is still active work (mirrors the merge archiver).
  if (thread.latestTurn?.state === "running") return false;
  if (threadHasQueuedTurnStart(thread, { now })) return false;
  return true;
}

// Anchored on `settledAt`: due once the configured day count has fully elapsed.
export function resolveSettledAutoArchiveDue(
  thread: OrchestrationThread,
  now: string,
  afterDays: number,
): boolean {
  const settledAt = (thread.settledAt ?? null) as string | null;
  if (settledAt === null) return false;
  const settledAtMs = Date.parse(settledAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(settledAtMs) || !Number.isFinite(nowMs)) return false;
  return settledAtMs + afterDays * DAY_MS <= nowMs;
}

// Read-model check shared by the sweep plan and the admission guard so the two
// cannot drift. `afterDays === null` means never: always false.
export function canAutoArchiveSettledThreadNow(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
  now: string,
  afterDays: number | null,
): boolean {
  if (afterDays === null) return false;
  const thread = readModel.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) return false;
  if (!isSettledAutoArchiveCandidate(thread, now)) return false;
  if (!resolveSettledAutoArchiveDue(thread, now, afterDays)) return false;
  // `thread.archive` cascades through `collectActiveThreadSubtree`, so every
  // surviving member must be due too — otherwise archiving the root would cut
  // short a descendant's own clock (or kill its active work, which already
  // fails candidacy).
  return collectActiveThreadSubtree(readModel, threadId).every(
    (member) =>
      isSettledAutoArchiveCandidate(member, now) &&
      resolveSettledAutoArchiveDue(member, now, afterDays),
  );
}

export type SettledAutoArchiveCandidate = {
  readonly threadId: ThreadId;
};

// Topmost due roots only: `thread.archive` already cascades, so dispatching a
// nested due thread alongside its due ancestor would be redundant.
export function planSettledAutoArchive(
  readModel: OrchestrationReadModel,
  now: string,
  afterDays: number | null,
): ReadonlyArray<SettledAutoArchiveCandidate> {
  if (afterDays === null) return [];
  const due = readModel.threads.filter((thread) =>
    canAutoArchiveSettledThreadNow(readModel, thread.id, now, afterDays),
  );
  const parentByThreadId = new Map(
    readModel.threads.flatMap((thread) =>
      thread.parentThreadId === undefined || thread.parentThreadId === null
        ? []
        : ([[thread.id, thread.parentThreadId]] as const),
    ),
  );
  const dueIds = new Set(due.map((thread) => thread.id));
  const hasDueAncestor = (threadId: ThreadId) => {
    const visited = new Set<ThreadId>();
    let parentId = parentByThreadId.get(threadId) ?? null;
    while (parentId !== null && !visited.has(parentId)) {
      if (dueIds.has(parentId)) return true;
      visited.add(parentId);
      parentId = parentByThreadId.get(parentId) ?? null;
    }
    return false;
  };
  return due
    .filter((thread) => !hasDueAncestor(thread.id))
    .map((thread) => ({ threadId: thread.id }));
}

// Fresh uuid per dispatch so a retried sweep never collides with a recorded
// command receipt; the archived filter makes repeats a no-op anyway.
export function settledAutoArchiveCommandId(threadId: ThreadId): CommandId {
  return CommandId.make(`server:settled-archive:${threadId}:${crypto.randomUUID()}`);
}
