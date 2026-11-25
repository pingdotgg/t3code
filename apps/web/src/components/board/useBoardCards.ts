import { useDelegatedUnderParent, useQuietThreadShells } from "../../state/entities";
import { filterSidebarV2VisibleThreads, useSnoozeWakeClock } from "../Sidebar.logic";
import { resolveBoardCard, type BoardCard } from "./threadBoard.logic";

/**
 * Every thread that is on the board, from the shells the sidebar already holds. Quiet shells
 * skip streaming ticks, and the snooze clock re-renders exactly when a snoozed thread wakes.
 */
export function useBoardCards(): ReadonlyArray<BoardCard> {
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const now = new Date(useSnoozeWakeClock(threads)).toISOString();
  const cards: BoardCard[] = [];
  for (const thread of filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent)) {
    const card = resolveBoardCard(thread, now);
    if (card !== null) cards.push(card);
  }
  return cards;
}
