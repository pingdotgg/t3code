// Fork: the sub-agents Kaluwa's folder tree nests under each thread, read from the thread shells
// the client already holds (no extra requests). Arrays keep their identity while nothing a row
// shows changed, so streaming elsewhere does not re-render the tree.
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  groupKaluwaSubagentChildren,
  type KaluwaSubagentChild,
  sameKaluwaChildren,
} from "../components/sidebar/kaluwaSidebarTree.logic";
import { resolveStorage } from "../lib/storage";
import { environmentThreadShells } from "./threads";

const NO_CHILDREN: ReadonlyArray<KaluwaSubagentChild> = Object.freeze([]);
const NO_INDEX: ReadonlyMap<string, ReadonlyArray<KaluwaSubagentChild>> = new Map();

export const kaluwaSubagentIndexAtom = (() => {
  let previous = NO_INDEX;
  return Atom.make((get) => {
    const next = groupKaluwaSubagentChildren(get(environmentThreadShells.quietThreadShellsAtom));
    if (next.size === 0) {
      previous = NO_INDEX;
      return previous;
    }
    let changed = next.size !== previous.size;
    const stable = new Map<string, ReadonlyArray<KaluwaSubagentChild>>();
    for (const [parentKey, children] of next) {
      const before = previous.get(parentKey);
      if (before !== undefined && sameKaluwaChildren(before, children)) {
        stable.set(parentKey, before);
      } else {
        stable.set(parentKey, children);
        changed = true;
      }
    }
    if (!changed) return previous;
    previous = stable;
    return stable;
  }).pipe(Atom.withLabel("kaluwa-subagent-index"));
})();

const subagentChildrenAtomFamily = Atom.family((parentKey: string) =>
  Atom.make((get) => get(kaluwaSubagentIndexAtom).get(parentKey) ?? NO_CHILDREN).pipe(
    Atom.withLabel(`kaluwa-subagent-children:${parentKey}`),
  ),
);
const NO_CHILDREN_ATOM = Atom.make(NO_CHILDREN).pipe(
  Atom.withLabel("kaluwa-subagent-children:none"),
);

export function useKaluwaSubagentChildren(
  parentKey: string | null,
): ReadonlyArray<KaluwaSubagentChild> {
  return useAtomValue(
    parentKey === null ? NO_CHILDREN_ATOM : subagentChildrenAtomFamily(parentKey),
  );
}

const MAX_REMEMBERED_FOLDS = 200;

interface KaluwaSubagentFoldState {
  /** Parents the user folded open or closed, against the mode's default. */
  readonly open: Readonly<Record<string, boolean>>;
  readonly setOpen: (parentKey: string, open: boolean) => void;
}

export const useKaluwaSubagentFolds = create<KaluwaSubagentFoldState>()(
  persist(
    (set) => ({
      open: {},
      setOpen: (parentKey, open) =>
        set((state) => {
          const { [parentKey]: _previous, ...rest } = state.open;
          const entries = Object.entries(rest);
          return {
            open: Object.fromEntries([
              ...entries.slice(Math.max(0, entries.length - MAX_REMEMBERED_FOLDS + 1)),
              [parentKey, open],
            ]),
          };
        }),
    }),
    {
      name: "kaluwa:subagent-folds:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ open }) => ({ open }),
    },
  ),
);

/** Nested tree starts open; the count chip starts closed. */
export function isKaluwaSubagentFoldOpen(
  open: Readonly<Record<string, boolean>>,
  parentKey: string,
  mode: "tree" | "chip",
): boolean {
  return open[parentKey] ?? mode === "tree";
}
