import { Atom, type AtomRegistry } from "effect/reactivity";

import { localState } from "./boards";

export type FrameOrder = Readonly<Record<string, ReadonlyArray<string>>>;

/** The order the user dragged each lane's frames to, by board id then lane. The saved order replaces the empty one on launch. */
export const frameOrderAtom = Atom.writable(
  (get): Readonly<Record<string, FrameOrder>> => {
    void localState.read().then((state) => get.setSelf(state.frameOrder));
    return {};
  },
  (context, next: Readonly<Record<string, FrameOrder>>) => context.setSelf(next),
).pipe(Atom.keepAlive, Atom.withLabel("frame-order"));

export function saveFrameOrder(
  registry: AtomRegistry.AtomRegistry,
  boardId: string,
  lane: string,
  keys: ReadonlyArray<string>,
) {
  const change = (all: Readonly<Record<string, FrameOrder>>) => ({
    ...all,
    [boardId]: { ...all[boardId], [lane]: keys },
  });
  registry.set(frameOrderAtom, change(registry.get(frameOrderAtom)));
  return localState.update((state) => ({ ...state, frameOrder: change(state.frameOrder) }));
}

/** The agent the peek drawer reads, with the ticket whose frame it opened from. */
export interface Peek {
  readonly threadId: string | null;
  readonly ticketKey: string | null;
}

export const peekAtom = Atom.make<Peek | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("board-peek"),
);
