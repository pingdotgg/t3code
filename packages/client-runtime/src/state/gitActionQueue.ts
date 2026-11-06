import type { GitStackedAction, ScopedThreadRef } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";

export interface QueuedGitAction {
  readonly action: GitStackedAction;
  readonly run: () => void;
  readonly onDropped: () => void;
}

const threadKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

/**
 * Holds one action per thread until its run ends. It stays on the client so the action starts as
 * an ordinary request with the usual guards, and an older server cannot run it early.
 */
export function createGitActionQueue(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>;
}) {
  const { registry } = input;
  const queuedAtom = Atom.family((_key: string) =>
    Atom.make<GitStackedAction | null>(null).pipe(Atom.keepAlive),
  );
  const none = Atom.make<GitStackedAction | null>(null);
  const subscriptions = new Map<string, () => void>();

  const clear = (key: string) => {
    subscriptions.get(key)?.();
    subscriptions.delete(key);
    registry.set(queuedAtom(key), null);
  };

  const settle = (key: string, item: QueuedGitAction, shell: EnvironmentThreadShell | null) => {
    if (threadRuntimeIsActive(shell?.runtime)) return;
    clear(key);
    const status = shell?.runtime?.status;
    // Anything but a clean finish may leave the half-done work the queue exists to avoid.
    const finished = shell !== null && (!status || status === "completed" || status === "idle");
    if (finished) item.run();
    else item.onDropped();
  };

  return {
    queuedActionAtom: (ref: ScopedThreadRef | null) =>
      ref === null ? none : queuedAtom(threadKey(ref)),
    enqueue: (ref: ScopedThreadRef, item: QueuedGitAction) => {
      const key = threadKey(ref);
      const shellAtom = input.threadShellAtom(ref);
      clear(key);
      registry.set(queuedAtom(key), item.action);
      subscriptions.set(
        key,
        registry.subscribe(shellAtom, (shell) => settle(key, item, shell)),
      );
      settle(key, item, registry.get(shellAtom));
    },
    cancel: (ref: ScopedThreadRef) => clear(threadKey(ref)),
  };
}
