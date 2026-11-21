import { Atom } from "effect/reactivity";

import type { CiReading } from "../checks/CiDot";

/** A ticket picked in the Checks tab, with the board it was picked on, since ticket keys repeat across boards. */
interface ChecksPick {
  readonly board: string;
  readonly ticket: string;
}

/** The pick the Checks tab follows, or null to follow the explorer's root. Choosing a root clears it. */
export const checksPickAtom = Atom.make<ChecksPick | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("checks-pick"),
);

export const pickedTicket = (pick: ChecksPick | null, board: string): string | null =>
  pick !== null && pick.board === board ? pick.ticket : null;

/** How the shown pull request's checks read, for the dot on the tab's icon. The tab sets it while a board is open. */
export const checksDotAtom = Atom.make<CiReading>("none").pipe(
  Atom.keepAlive,
  Atom.withLabel("checks-dot"),
);
