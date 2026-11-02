import type { EnvironmentId, OrchestrationV2ShellSnapshot, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";

/**
 * Threads their server says it no longer has, hidden from the lists until the environment's
 * shell generation next changes. The next authoritative snapshot (or a rebuilt shell) decides
 * again, so a thread the server still lists comes back instead of staying hidden forever.
 */
const forgottenThreadsAtom = Atom.make<ReadonlyMap<EnvironmentId, ReadonlySet<ThreadId>>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("forgotten-threads"));

function updateForgotten(
  environmentId: EnvironmentId,
  change: (threads: Set<ThreadId>) => void,
): void {
  const current = appAtomRegistry.get(forgottenThreadsAtom);
  const threads = new Set(current.get(environmentId));
  change(threads);
  const next = new Map(current);
  if (threads.size === 0) next.delete(environmentId);
  else next.set(environmentId, threads);
  appAtomRegistry.set(forgottenThreadsAtom, next);
}

export function forgetThread(environmentId: EnvironmentId, threadId: ThreadId): void {
  if (appAtomRegistry.get(forgottenThreadsAtom).get(environmentId)?.has(threadId)) return;
  const shellState = environmentShell.stateValueAtom(environmentId);
  const { generation } = appAtomRegistry.get(shellState);
  updateForgotten(environmentId, (threads) => threads.add(threadId));
  let expired = false;
  const expire = () => {
    if (expired) return;
    expired = true;
    unsubscribeShell();
    unsubscribeCatalog();
    updateForgotten(environmentId, (threads) => threads.delete(threadId));
  };
  // Any generation change expires the entry for good: cached shells reuse generation 0, so
  // comparing numbers later could hide the thread again after a rebuild.
  const unsubscribeShell = appAtomRegistry.subscribe(shellState, (state) => {
    if (state.generation !== generation) expire();
  });
  // A removed environment's shell stops emitting, so its entries expire with it.
  const unsubscribeCatalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    (catalog) => {
      if (catalog.isReady && !catalog.entries.has(environmentId)) expire();
    },
  );
}

export function withoutForgottenThreads(
  snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): OrchestrationV2ShellSnapshot | null => {
      const snapshot = get(snapshotAtom(environmentId));
      const forgotten = get(forgottenThreadsAtom).get(environmentId);
      if (snapshot === null || forgotten === undefined) return snapshot;
      const threads = snapshot.threads.filter((thread) => !forgotten.has(thread.id));
      return threads.length === snapshot.threads.length ? snapshot : { ...snapshot, threads };
    }).pipe(Atom.withLabel(`visible-shell-snapshot:${environmentId}`)),
  );
}
