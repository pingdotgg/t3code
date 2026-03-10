import { derivePendingUserInputs } from "./session-logic";
import type { Thread } from "./types";
import type { SidebarThreadOrder } from "./appSettings";

export interface SidebarThreadEntryLike {
  id: string;
  createdAt: string;
  thread: Thread | null;
}

function latestIso(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

export function getSidebarThreadRecentActivityAt(entry: SidebarThreadEntryLike): string {
  const thread = entry.thread;
  if (thread === null) {
    return entry.createdAt;
  }

  let latestActivityAt = latestIso(entry.createdAt, thread.createdAt);

  for (const message of thread.messages) {
    if (message.role === "user") {
      latestActivityAt = latestIso(latestActivityAt, message.createdAt);
      continue;
    }

    if (message.role === "assistant" && !message.streaming && message.completedAt) {
      latestActivityAt = latestIso(latestActivityAt, message.completedAt);
    }
  }

  for (const proposedPlan of thread.proposedPlans) {
    latestActivityAt = latestIso(latestActivityAt, proposedPlan.updatedAt);
  }

  for (
    const pendingUserInput of derivePendingUserInputs(thread.activities, {
      latestTurn: thread.latestTurn,
      session: thread.session,
    })
  ) {
    latestActivityAt = latestIso(latestActivityAt, pendingUserInput.createdAt);
  }

  return latestActivityAt;
}

export function getSidebarThreadSortTimestamp(
  entry: SidebarThreadEntryLike,
  order: SidebarThreadOrder,
): string {
  return order === "created-at" ? entry.createdAt : getSidebarThreadRecentActivityAt(entry);
}

export function sortSidebarThreadEntries<T extends SidebarThreadEntryLike>(
  entries: readonly T[],
  order: SidebarThreadOrder,
): T[] {
  return [...entries].toSorted((left, right) => {
    const bySortTimestamp =
      getSidebarThreadSortTimestamp(right, order).localeCompare(
        getSidebarThreadSortTimestamp(left, order),
      );
    if (bySortTimestamp !== 0) return bySortTimestamp;

    const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
    if (byCreatedAt !== 0) return byCreatedAt;

    return right.id.localeCompare(left.id);
  });
}
