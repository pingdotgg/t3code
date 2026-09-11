import type { TurnId } from "@t3tools/contracts";

interface TurnSection<Entry> {
  readonly id: string;
  readonly turnId: TurnId;
  readonly entries: Entry[];
  readonly startBoundary: string | null;
  endBoundary: string | null;
  readonly isContinuation: boolean;
  continues: boolean;
}

/** Group a turn's work without crossing a user message, even when a steer keeps its turn ID. */
export function groupTurnSections<Entry extends { readonly id: string }>(
  entries: ReadonlyArray<Entry>,
  userTimestamp: (entry: Entry) => string | null,
  entryTurnId: (entry: Entry) => TurnId | null,
): TurnSection<Entry>[] {
  const sections: TurnSection<Entry>[] = [];
  const currentByTurn = new Map<TurnId, TurnSection<Entry>>();
  const lastByTurn = new Map<TurnId, TurnSection<Entry>>();
  let pendingUserBoundary: string | null = null;

  for (const entry of entries) {
    const boundary = userTimestamp(entry);
    if (boundary !== null) {
      for (const section of currentByTurn.values()) section.endBoundary = boundary;
      currentByTurn.clear();
      pendingUserBoundary = boundary;
      continue;
    }
    const turnId = entryTurnId(entry);
    if (turnId === null) continue;
    let section = currentByTurn.get(turnId);
    if (!section) {
      const previous = lastByTurn.get(turnId);
      if (previous) previous.continues = true;
      section = {
        id: previous ? `turn-fold:${turnId}:${entry.id}` : `turn-fold:${turnId}`,
        turnId,
        entries: [],
        startBoundary: pendingUserBoundary,
        endBoundary: null,
        isContinuation: previous !== undefined,
        continues: false,
      };
      // A user boundary starts at most one provider turn.
      pendingUserBoundary = null;
      currentByTurn.set(turnId, section);
      lastByTurn.set(turnId, section);
      sections.push(section);
    }
    section.entries.push(entry);
  }
  return sections;
}
