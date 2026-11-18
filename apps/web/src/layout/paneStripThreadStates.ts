import { deadlineStore } from "@t3tools/client-runtime/clock";
import {
  arrayElementsEqual,
  parseThreadKey,
  threadKey,
} from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../state/threads";
import type { LayoutPane } from "./layoutModel";
import {
  paneStripThreadRef,
  resolvePaneStripThreadStates,
  type PaneStripThreadState,
} from "./paneStrip.logic";

type ThreadStates = ReadonlyArray<PaneStripThreadState | null>;

const EMPTY_THREAD_STATES: ThreadStates = [];
const EMPTY_THREAD_STATES_ATOM = Atom.make(EMPTY_THREAD_STATES).pipe(
  Atom.withLabel("pane-strip-thread-states:empty"),
);

/**
 * Keyed by a pane's chat thread keys, so every header of the pane shares one
 * atom and redraws only when a tab changes shelf, not on each shell update.
 * It reads again when the earliest snooze ends.
 */
const threadStatesAtom = Atom.family((keys: string) => {
  const refs = (JSON.parse(keys) as ReadonlyArray<string>).map(parseThreadKey);
  let previous = EMPTY_THREAD_STATES;
  return Atom.make((get) => {
    const threads = refs.map((ref) => get(environmentThreadShells.quietThreadShellAtom(ref)));
    const { states, wakeAt } = resolvePaneStripThreadStates(threads, Date.now());
    if (wakeAt !== null) get.addFinalizer(deadlineStore(wakeAt).subscribe(() => get.refreshSelf()));
    if (arrayElementsEqual(previous, states)) return previous;
    previous = states;
    return states;
  }).pipe(Atom.withLabel(`pane-strip-thread-states:${keys}`));
});

export function paneStripThreadKeys(pane: LayoutPane): string[] {
  return pane.tabs.flatMap((tab) => {
    const ref = paneStripThreadRef(tab);
    return ref === null ? [] : [threadKey(ref)];
  });
}

export function paneStripThreadStatesAtom(keys: readonly string[]): Atom.Atom<ThreadStates> {
  return keys.length === 0 ? EMPTY_THREAD_STATES_ATOM : threadStatesAtom(JSON.stringify(keys));
}

export function paneStripThreadStateOf(
  keys: readonly string[],
  states: ThreadStates,
): (ref: ScopedThreadRef) => PaneStripThreadState | null {
  const byKey = new Map(keys.map((key, index) => [key, states[index] ?? null]));
  return (ref) => byKey.get(threadKey(ref)) ?? null;
}
