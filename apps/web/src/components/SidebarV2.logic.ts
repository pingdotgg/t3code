import { type ExecutionEnvironmentDescriptor, type ThreadId } from "@t3tools/contracts";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";

import { isMacPlatform } from "../lib/utils";
import { isThreadActivelyWorking } from "../session-logic";
import { selectVisibleSidebarThreads } from "../sidebarThreadTree";
import type { SidebarThreadSummary, TurnDiffSummary } from "../types";

export type ThreadLifecycleSupport = {
  readonly settlement: boolean;
  readonly snooze: boolean;
};

export function shouldReserveMacSidebarChrome({
  isElectron,
  platform,
}: {
  readonly isElectron: boolean;
  readonly platform: string;
}): boolean {
  return isElectron && isMacPlatform(platform);
}

/**
 * Lifecycle capabilities are resolved per environment rather than reduced to a
 * single flag for the whole sidebar: an environment whose server predates
 * thread.settle/snooze must degrade only its own rows, not disable the inbox
 * for every other environment's threads.
 */
export function resolveThreadLifecycleSupport(
  descriptors: readonly (ExecutionEnvironmentDescriptor | null | undefined)[],
): ReadonlyMap<string, ThreadLifecycleSupport> {
  const byEnvironment = new Map<string, ThreadLifecycleSupport>();
  for (const descriptor of descriptors) {
    if (!descriptor) continue;
    byEnvironment.set(descriptor.environmentId, {
      settlement: descriptor.capabilities.threadSettlement === true,
      snooze: descriptor.capabilities.threadSnooze === true,
    });
  }
  return byEnvironment;
}

/**
 * Bulk shelf actions fan out to one command per thread, so they must offer only
 * threads that can actually accept it. An unsupported environment or
 * blocked-on-you work is rejected server-side, which would half-apply the
 * action and report a failure the user cannot act on.
 */
export function selectSnoozeShelfBulkTargets({
  snoozed,
  lifecycleSupport,
  now,
}: {
  readonly snoozed: readonly SidebarThreadSummary[];
  readonly lifecycleSupport: ReadonlyMap<string, ThreadLifecycleSupport>;
  readonly now: string;
}): {
  readonly wakeable: readonly SidebarThreadSummary[];
  readonly reschedulable: readonly SidebarThreadSummary[];
} {
  const wakeable = snoozed.filter(
    (thread) => lifecycleSupport.get(thread.environmentId)?.snooze === true,
  );
  return {
    wakeable,
    reschedulable: wakeable.filter((thread) => canSnooze(thread, { now })),
  };
}

function sortByRecent(left: SidebarThreadSummary, right: SidebarThreadSummary): number {
  const leftAt = left.updatedAt ?? left.createdAt;
  const rightAt = right.updatedAt ?? right.createdAt;
  if (leftAt !== rightAt) {
    return leftAt < rightAt ? 1 : -1;
  }
  return left.title.localeCompare(right.title);
}

export interface SidebarV2Shelves {
  readonly active: readonly SidebarThreadSummary[];
  readonly snoozed: readonly SidebarThreadSummary[];
  readonly settled: readonly SidebarThreadSummary[];
}

export function resolveSidebarV2ThreadRouteTarget(
  thread: Pick<SidebarThreadSummary, "id" | "virtualAgentRun">,
): {
  readonly threadId: ThreadId;
  readonly agentTaskId: string | null;
} {
  const agentRun = thread.virtualAgentRun;
  return agentRun
    ? { threadId: agentRun.parentThreadId, agentTaskId: agentRun.taskId }
    : { threadId: thread.id, agentTaskId: null };
}

export function classifySidebarV2Shelves(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly now: string;
}): SidebarV2Shelves {
  const active: SidebarThreadSummary[] = [];
  const snoozed: SidebarThreadSummary[] = [];
  const settled: SidebarThreadSummary[] = [];
  for (const thread of selectVisibleSidebarThreads(input.threads)) {
    if (effectiveSnoozed(thread, { now: input.now })) {
      snoozed.push(thread);
    } else if (effectiveSettled(thread, { now: input.now })) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }
  return {
    active: active.toSorted(sortByRecent),
    snoozed: snoozed.toSorted(sortByRecent),
    settled: settled.toSorted(sortByRecent),
  };
}

// ── Sidebar v2 status model ─────────────────────────────────────────
// Five visual states resolved in strict priority order. Colour is reserved
// for "act now" (approval), "answer me" (input), "in motion" (working) and
// "broken" (failed); ready is the resting state a card labels as Done once
// its completion has not been seen yet.
export type SidebarV2Status = "approval" | "input" | "working" | "failed" | "ready";

type SidebarV2StatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session" | "virtualAgentRun"
>;

export function resolveSidebarV2Status(thread: SidebarV2StatusInput): SidebarV2Status {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  // Upstream reads a provider-session phase this fork does not carry, so
  // "working" reuses the same predicate v1's status pill does — including the
  // pre-adoption `connecting` phase, which is work the user is waiting on.
  if (
    thread.virtualAgentRun?.status === "running" ||
    isThreadActivelyWorking(thread.latestTurn, thread.session) ||
    thread.session?.status === "connecting"
  ) {
    return "working";
  }
  if (thread.session?.status === "error") return "failed";
  return "ready";
}

export interface SidebarV2StatusLabel {
  readonly label: "Working" | "Approval" | "Input" | "Failed" | "Done";
  readonly className: string;
  readonly showElapsed: boolean;
}

/**
 * The right-hand label a card row shows at rest. A `ready` thread only earns
 * one while its completion is unseen, so a row the user already read falls
 * back to its relative timestamp instead of shouting "Done" forever.
 */
export function resolveSidebarV2StatusLabel(input: {
  readonly status: SidebarV2Status;
  readonly unseenCompletion: boolean;
}): SidebarV2StatusLabel | null {
  switch (input.status) {
    case "working":
      return {
        label: "Working",
        className: "text-sky-600 dark:text-sky-400",
        showElapsed: true,
      };
    case "approval":
      return {
        label: "Approval",
        className: "text-amber-700 dark:text-amber-300",
        showElapsed: false,
      };
    case "input":
      return {
        label: "Input",
        className: "text-indigo-600 dark:text-indigo-300",
        showElapsed: false,
      };
    case "failed":
      return {
        label: "Failed",
        className: "text-red-700 dark:text-red-300",
        showElapsed: false,
      };
    case "ready":
      return input.unseenCompletion
        ? {
            label: "Done",
            className: "text-emerald-700 dark:text-emerald-300",
            showElapsed: false,
          }
        : null;
  }
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate. */
export function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

/** The timestamp a working thread's elapsed label counts from: the running
    turn's start (request time until adoption), falling back to the session's
    last transition when the turn projection lags behind. */
export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestTurn" | "session">,
): string | null {
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null) {
    return firstValidTimestamp(turn.startedAt, turn.requestedAt, thread.session?.updatedAt);
  }
  return firstValidTimestamp(thread.session?.updatedAt);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface TurnDiffStats {
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * Line counts for a turn's checkpoint. Per-file additions/deletions are
 * optional on the wire, so a checkpoint that only carries paths contributes
 * nothing and the row renders no diff rather than a misleading `+0 −0`.
 */
export function latestTurnDiffStats(
  summary: TurnDiffSummary | null | undefined,
): TurnDiffStats | null {
  if (!summary) return null;
  const files = summary.turnFiles ?? summary.files;
  let insertions = 0;
  let deletions = 0;
  let counted = false;
  for (const file of files) {
    if (file.additions !== undefined) {
      insertions += file.additions;
      counted = true;
    }
    if (file.deletions !== undefined) {
      deletions += file.deletions;
      counted = true;
    }
  }
  return counted ? { insertions, deletions } : null;
}

/**
 * Sidebar rows are narrow and every row carries a timestamp, so the shared
 * "3m ago" phrasing spends horizontal space on a word that is identical on
 * every row. The suffix is dropped rather than reworded because the column
 * position already says "when".
 */
export function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -" ago".length) : label;
}
