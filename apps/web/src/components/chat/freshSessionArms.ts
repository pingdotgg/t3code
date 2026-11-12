import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

/** Threads whose next message starts a fresh provider session, keyed by thread, valued by when it was armed. */
const freshSessionArmsAtom = Atom.make<Readonly<Record<string, number>>>({}).pipe(Atom.keepAlive);

export function armFreshSession(threadKey: string): void {
  appAtomRegistry.set(freshSessionArmsAtom, {
    ...appAtomRegistry.get(freshSessionArmsAtom),
    [threadKey]: Date.now(),
  });
}

/** With `arm`, clears only that arm, so a send never consumes one made while it was in flight. */
export function disarmFreshSession(threadKey: string, arm?: number): void {
  const current = appAtomRegistry.get(freshSessionArmsAtom);
  if (current[threadKey] === undefined || (arm !== undefined && current[threadKey] !== arm)) return;
  const { [threadKey]: _removed, ...rest } = current;
  appAtomRegistry.set(freshSessionArmsAtom, rest);
}

export function readFreshSessionArm(threadKey: string): number | undefined {
  return appAtomRegistry.get(freshSessionArmsAtom)[threadKey];
}

export function useFreshSessionArmed(threadKey: string): boolean {
  return useAtomValue(freshSessionArmsAtom)[threadKey] !== undefined;
}
