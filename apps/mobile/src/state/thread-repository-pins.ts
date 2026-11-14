import { useAtomValue } from "@effect/atom-react";
import {
  pinThreadRepository,
  unpinThreadRepository,
  type PinnedThreadRepository,
} from "@t3tools/client-runtime/state/thread-repositories";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

const NO_PINS: ReadonlyArray<PinnedThreadRepository> = Object.freeze([]);

const pinsKey = (ref: ScopedThreadRef) => `${ref.environmentId}\u0000${ref.threadId}`;

// Kept for the session only: a relaunch shows the repositories the thread changed.
const pinsByThreadAtom = Atom.make<Readonly<Record<string, ReadonlyArray<PinnedThreadRepository>>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-repository-pins"));

function updatePins(
  ref: ScopedThreadRef,
  change: (pinned: ReadonlyArray<PinnedThreadRepository>) => ReadonlyArray<PinnedThreadRepository>,
): void {
  const key = pinsKey(ref);
  appAtomRegistry.update(pinsByThreadAtom, (current) => {
    const pinned = current[key] ?? NO_PINS;
    const next = change(pinned);
    return next === pinned ? current : { ...current, [key]: next };
  });
}

export function pinRepositoryToThread(
  ref: ScopedThreadRef,
  repository: PinnedThreadRepository,
): void {
  updatePins(ref, (pinned) => pinThreadRepository(pinned, repository));
}

export function unpinRepositoryFromThread(ref: ScopedThreadRef, repositoryPath: string): void {
  updatePins(ref, (pinned) => unpinThreadRepository(pinned, repositoryPath));
}

export function useThreadRepositoryPins(
  ref: ScopedThreadRef | null,
): ReadonlyArray<PinnedThreadRepository> {
  return useAtomValue(pinsByThreadAtom, (current) =>
    ref === null ? NO_PINS : (current[pinsKey(ref)] ?? NO_PINS),
  );
}
