import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/unstable/reactivity";

import type { AtomCommand } from "./runtime.ts";

interface PendingThreadUpdate {
  readonly threadId: ThreadId;
  readonly apply: (thread: OrchestrationThreadShell) => OrchestrationThreadShell;
  sequence?: number;
}

export function createOptimisticThreadLifecycle(
  sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>,
) {
  const pendingAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<PendingThreadUpdate>>([]).pipe(Atom.keepAlive),
  );
  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const snapshot = get(sourceSnapshotAtom(environmentId));
      const pending = get(pendingAtom(environmentId));
      if (snapshot === null || pending.length === 0) return snapshot;
      const byThread = new Map<ThreadId, PendingThreadUpdate[]>();
      for (const update of pending) {
        if (update.sequence !== undefined && update.sequence <= snapshot.snapshotSequence) continue;
        const updates = byThread.get(update.threadId) ?? [];
        updates.push(update);
        byThread.set(update.threadId, updates);
      }
      if (byThread.size === 0) return snapshot;
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) =>
          (byThread.get(thread.id) ?? []).reduce(
            (current, update) => update.apply(current),
            thread,
          ),
        ),
      };
    }),
  );

  function wrap<Input extends { readonly threadId: ThreadId }, E>(
    command: AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: Input },
      { readonly sequence: number },
      E
    >,
    apply: (
      thread: OrchestrationThreadShell,
      input: Input,
      now: string,
      accepted: boolean,
    ) => OrchestrationThreadShell,
  ): typeof command {
    return {
      label: command.label,
      run: async (registry, target) => {
        const now = DateTime.formatIso(DateTime.nowUnsafe());
        const pending = pendingAtom(target.environmentId);
        const source = sourceSnapshotAtom(target.environmentId);
        const update: PendingThreadUpdate = {
          threadId: target.input.threadId,
          apply: (thread) => apply(thread, target.input, now, update.sequence !== undefined),
        };
        const remove = () =>
          registry.update(pending, (current) => current.filter((item) => item !== update));
        registry.update(pending, (current) => [...current, update]);
        let confirmed = false;
        try {
          const result = await command.run(registry, target);
          if (result._tag === "Success") {
            update.sequence = result.value.sequence;
            registry.update(pending, (current) => [...current]);
            const reconcile = (snapshot: OrchestrationShellSnapshot | null) => {
              if (snapshot === null || snapshot.snapshotSequence >= result.value.sequence) {
                remove();
                unsubscribe();
              }
            };
            const unsubscribe = registry.subscribe(source, reconcile);
            reconcile(registry.get(source));
            confirmed = true;
          }
          return result;
        } finally {
          if (!confirmed) remove();
        }
      },
    };
  }

  return { snapshotAtom, wrap };
}
