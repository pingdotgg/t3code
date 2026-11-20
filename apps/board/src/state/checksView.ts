import { Atom } from "effect/reactivity";

import type { CiReading } from "../checks/CiDot";

/** The ticket whose pull request the Checks tab shows, or null to follow the explorer's root. */
export const checksTicketAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("checks-ticket"),
);

/** How the shown pull request's checks read, for the dot on the tab's icon. The tab sets it while a board is open. */
export const checksDotAtom = Atom.make<CiReading>("none").pipe(
  Atom.keepAlive,
  Atom.withLabel("checks-dot"),
);
