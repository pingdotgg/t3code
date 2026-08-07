import type { SidebarV3ThreadSortOrder } from "@t3tools/contracts/settings";

import type { SidebarThreadSummary } from "../types";
import { parseTimestampDate } from "../timestampFormat";
import {
  hasUnseenCompletion,
  parseTimestampMs,
  resolveSidebarV2Status,
  type SidebarV2Status,
} from "./Sidebar.logic";

// Sidebar v3 splits the live (non-pinned, non-snoozed, non-settled) list into
// status sections. Snoozed and settled stay shelves, exactly as in v2 — the
// sections only subdivide what v2 called the active inbox.
export type SidebarV3Section = "attention" | "working" | "ready";

// Severity order inside Needs attention: blockers first, then the wake
// signal, then finished-but-unread work. Ties fall through to the section
// sort (created/activity) so the order stays deterministic.
export type SidebarV3AttentionKind = "approval" | "input" | "failed" | "woke" | "done";

const ATTENTION_SEVERITY_RANK: Record<SidebarV3AttentionKind, number> = {
  approval: 0,
  input: 1,
  failed: 2,
  woke: 3,
  done: 4,
};

export type SidebarV3Classification = {
  status: SidebarV2Status;
  isUnread: boolean;
  isWoke: boolean;
  section: SidebarV3Section;
  attentionKind: SidebarV3AttentionKind | null;
};

/** Same woke predicate as the v2 row: a wake shows until the user visits the
    thread after it, and an unparseable visit timestamp counts as
    never-visited so corrupt local data cannot eat the wake signal. */
export function isThreadWoke(input: {
  wokeAt: string | null;
  lastVisitedAt: string | undefined;
}): boolean {
  const wokeAtDate = input.wokeAt === null ? null : parseTimestampDate(input.wokeAt);
  if (wokeAtDate === null) return false;
  const lastVisitedDate =
    input.lastVisitedAt === undefined ? null : parseTimestampDate(input.lastVisitedAt);
  return lastVisitedDate === null || lastVisitedDate < wokeAtDate;
}

type ClassificationInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "backgroundLiveness"
>;

/**
 * Classify one live thread into its v3 section. Approval/input/failed always
 * need a human; a woken or finished-unread thread does too, regardless of the
 * underlying status. Working/monitoring recede into the Working section, and
 * everything read-and-quiet lands in Ready.
 */
export function classifyThreadForSidebarV3(
  thread: ClassificationInput,
  context: { lastVisitedAt: string | undefined; wokeAt: string | null },
): SidebarV3Classification {
  const status = resolveSidebarV2Status(thread);
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt: context.lastVisitedAt });
  const isWoke = isThreadWoke({ wokeAt: context.wokeAt, lastVisitedAt: context.lastVisitedAt });
  const attentionKind: SidebarV3AttentionKind | null =
    status === "approval" || status === "input" || status === "failed"
      ? status
      : isWoke
        ? "woke"
        : isUnread
          ? "done"
          : null;
  const section: SidebarV3Section =
    attentionKind !== null
      ? "attention"
      : status === "working" || status === "monitoring"
        ? "working"
        : "ready";
  return { status, isUnread, isWoke, section, attentionKind };
}

type ActivityTimestampInput = Pick<
  SidebarThreadSummary,
  "latestUserMessageAt" | "latestTurn" | "createdAt"
>;

/** Latest GENUINE activity a row can claim: a user message or a turn
    lifecycle stamp — deliberately NOT `updatedAt`, which the server bumps on
    every projection write (title regeneration, pin/unpin, session
    heartbeats, terminal attach...) unrelated to the conversation. Sorting by
    that made "Last activity" reorder rows on background noise instead of
    real work — exactly the "springt dauernd" the row-jumping complaint was
    about. Falls back to createdAt so an untouched thread still holds a
    stable position instead of sinking to the epoch. Malformed stamps fall
    through. */
export function resolveActivityTimestampMs(thread: ActivityTimestampInput): number {
  let latest = 0;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latest) latest = parsed;
  }
  if (latest > 0) return latest;
  const created = Date.parse(thread.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

type SortableThread = ActivityTimestampInput & {
  readonly id: string;
  readonly createdAt: string;
};

/**
 * Section-internal sort. "created" keeps v2's static newest-created-first
 * order (rows never move while you look at them); "activity" floats the most
 * recently touched thread to the top.
 */
export function sortThreadsForSidebarV3<T extends SortableThread>(
  threads: readonly T[],
  order: SidebarV3ThreadSortOrder,
): T[] {
  const key =
    order === "activity"
      ? (thread: T) => resolveActivityTimestampMs(thread)
      : (thread: T) => parseTimestampMs(thread.createdAt);
  return [...threads].toSorted(
    (left, right) => key(right) - key(left) || left.id.localeCompare(right.id),
  );
}

/**
 * Needs-attention sort: severity buckets first (approval → input → failed →
 * woke → done), the chosen section sort as tiebreaker inside a bucket.
 * Callers pass the classification computed during partitioning so the sort
 * never re-derives (or disagrees with) section membership.
 */
export function sortAttentionThreadsForSidebarV3<T extends SortableThread>(
  threads: readonly T[],
  order: SidebarV3ThreadSortOrder,
  attentionKindOf: (thread: T) => SidebarV3AttentionKind,
): T[] {
  const sorted = sortThreadsForSidebarV3(threads, order);
  return sorted.toSorted(
    (left, right) =>
      ATTENTION_SEVERITY_RANK[attentionKindOf(left)] -
      ATTENTION_SEVERITY_RANK[attentionKindOf(right)],
  );
}
