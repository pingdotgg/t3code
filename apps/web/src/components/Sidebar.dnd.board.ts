import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { sidebarThreadKey, type SidebarDndSection } from "./Sidebar.dnd.logic";
import type { SidebarThreadDragTransaction } from "./Sidebar.dnd.logic";
import {
  firstValidTimestampMs,
  orderItemsByPreferredIds,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";

export type SidebarThreadBoardSections = Readonly<
  Record<SidebarDndSection, readonly EnvironmentThreadShell[]>
>;

function insertThreadAt(
  threads: readonly EnvironmentThreadShell[],
  thread: EnvironmentThreadShell,
  index: number,
): EnvironmentThreadShell[] {
  const next = [...threads];
  next.splice(Math.min(Math.max(0, index), next.length), 0, thread);
  return next;
}

export function buildSidebarDndBoardSections(input: {
  pinnedThreads: readonly EnvironmentThreadShell[];
  regularThreads: readonly EnvironmentThreadShell[];
  snoozedThreads: readonly EnvironmentThreadShell[];
  settledThreads: readonly EnvironmentThreadShell[];
  transaction: SidebarThreadDragTransaction | null;
}): SidebarThreadBoardSections {
  let pinned = [...input.pinnedThreads];
  let regular = [...input.regularThreads];
  let snoozed = [...input.snoozedThreads];
  let settled = [...input.settledThreads];
  const { transaction } = input;
  if (transaction === null) return { pinned, regular, snoozed, settled };

  const withoutSource = (items: readonly EnvironmentThreadShell[]) =>
    items.filter((thread) => sidebarThreadKey(thread) !== transaction.sourceThreadKey);
  pinned = withoutSource(pinned);
  regular = withoutSource(regular);
  snoozed = withoutSource(snoozed);
  settled = withoutSource(settled);

  if (transaction.phase !== "reconciling" || transaction.destinationSection === null) {
    switch (transaction.sourceSection) {
      case "pinned":
        pinned = insertThreadAt(pinned, transaction.sourceThread, transaction.sourceIndex);
        break;
      case "regular":
        regular = insertThreadAt(regular, transaction.sourceThread, transaction.sourceIndex);
        break;
      case "snoozed":
        snoozed = insertThreadAt(snoozed, transaction.sourceThread, transaction.sourceIndex);
        break;
      case "settled":
        settled = insertThreadAt(settled, transaction.sourceThread, transaction.sourceIndex);
        break;
    }
    return { pinned, regular, snoozed, settled };
  }

  const now = new Date().toISOString();
  switch (transaction.destinationSection) {
    case "pinned":
      pinned = orderItemsByPreferredIds({
        items: [
          ...pinned,
          {
            ...transaction.sourceThread,
            pinnedAt: now,
            settledOverride: "active" as const,
            settledAt: null,
            snoozedAt: null,
            snoozedUntil: null,
          },
        ],
        preferredIds: transaction.pinnedOrder ?? [],
        getId: sidebarThreadKey,
      });
      break;
    case "regular":
      regular = sortThreadsForSidebar([
        ...regular,
        {
          ...transaction.sourceThread,
          pinnedAt: null,
          pinOrderKey: null,
          settledOverride: "active" as const,
          settledAt: null,
          snoozedAt: null,
          snoozedUntil: null,
        },
      ]);
      break;
    case "snoozed":
      snoozed = [
        ...snoozed,
        {
          ...transaction.sourceThread,
          pinnedAt: null,
          pinOrderKey: null,
          settledOverride: "active" as const,
          settledAt: null,
          snoozedAt: now,
          snoozedUntil: transaction.snoozedUntil,
        },
      ].toSorted(
        (left, right) =>
          firstValidTimestampMs(left.snoozedUntil ?? null) -
          firstValidTimestampMs(right.snoozedUntil ?? null),
      );
      break;
    case "settled":
      settled = sortSettledThreadsForSidebar([
        ...settled,
        {
          ...transaction.sourceThread,
          pinnedAt: null,
          pinOrderKey: null,
          settledOverride: "settled" as const,
          settledAt: now,
          snoozedAt: null,
          snoozedUntil: null,
        },
      ]);
      break;
  }
  return { pinned, regular, snoozed, settled };
}
