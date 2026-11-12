import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

export type FreshSessionArm = {
  readonly at: number;
  /** When true, the fresh session gets a durable written recap of earlier history. */
  readonly withRecap: boolean;
};

/** Threads whose next message starts a fresh provider session, keyed by thread. */
const freshSessionArmsAtom = Atom.make<Readonly<Record<string, FreshSessionArm>>>({}).pipe(
  Atom.keepAlive,
);

export function armFreshSession(
  threadKey: string,
  options?: { readonly withRecap?: boolean },
): void {
  appAtomRegistry.set(freshSessionArmsAtom, {
    ...appAtomRegistry.get(freshSessionArmsAtom),
    [threadKey]: { at: Date.now(), withRecap: options?.withRecap === true },
  });
}

/** With `arm`, clears only that arm, so a send never consumes one made while it was in flight. */
export function disarmFreshSession(threadKey: string, arm?: FreshSessionArm): void {
  const current = appAtomRegistry.get(freshSessionArmsAtom);
  const existing = current[threadKey];
  if (
    existing === undefined ||
    (arm !== undefined && (existing.at !== arm.at || existing.withRecap !== arm.withRecap))
  ) {
    return;
  }
  const { [threadKey]: _removed, ...rest } = current;
  appAtomRegistry.set(freshSessionArmsAtom, rest);
}

export function readFreshSessionArm(threadKey: string): FreshSessionArm | undefined {
  return appAtomRegistry.get(freshSessionArmsAtom)[threadKey];
}

export function useFreshSessionArm(threadKey: string): FreshSessionArm | undefined {
  return useAtomValue(freshSessionArmsAtom)[threadKey];
}

export function useFreshSessionArmed(threadKey: string): boolean {
  return useFreshSessionArm(threadKey) !== undefined;
}
