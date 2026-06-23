import type { TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/**
 * Index of the rendered row materializing `entryId`, or null when not present
 * (i.e. hidden in a collapsed turn-fold). Work rows group multiple entries, so a
 * work match resolves to its containing row via `groupedEntries`, NOT row.id.
 */
export function locateRowForEntry(
  rows: ReadonlyArray<MessagesTimelineRow>,
  entryId: string,
  kind: "message" | "work" | "proposed-plan",
): number | null {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    if (kind === "work") {
      if (row.kind === "work" && row.groupedEntries.some((entry) => entry.id === entryId)) {
        return index;
      }
    } else if (row.kind === kind && row.id === entryId) {
      return index;
    }
  }
  return null;
}

/** The turn an entry belongs to (used to expand the right fold). */
export function findTurnIdForEntry(
  entries: ReadonlyArray<TimelineEntry>,
  entryId: string,
): TurnId | null {
  for (const entry of entries) {
    if (entry.id !== entryId) continue;
    if (entry.kind === "message") return entry.message.turnId ?? null;
    if (entry.kind === "work") return entry.entry.turnId ?? null;
    return null;
  }
  return null;
}
