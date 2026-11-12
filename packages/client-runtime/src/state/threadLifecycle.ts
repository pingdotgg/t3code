import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import { Atom } from "effect/reactivity";

import type { AtomCommand } from "./runtime.ts";

/** A command made while its environment was offline; `sent` ends once it is sent on reconnect. */
export interface QueuedThreadCommand<E> {
  readonly sent: Fiber.Fiber<{ readonly sequence: number }, E>;
}

interface PendingThreadUpdate {
  readonly threadId: ThreadId;
  readonly apply: (thread: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell;
  sequence?: number;
}

export function createOptimisticThreadLifecycle(
  sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
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

  // Until the durable snapshot catches up, an older pending update can still replace what shows.
  const pendingThreadIdsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlySet<ThreadId> =>
        new Set(get(pendingAtom(environmentId)).map((update) => update.threadId)),
    ),
  );

  function wrap<Input extends { readonly threadId: ThreadId }, E>(
    command: AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: Input },
      { readonly sequence: number } | QueuedThreadCommand<E>,
      E
    >,
    apply: (
      thread: OrchestrationV2ThreadShell,
      input: Input,
      now: DateTime.Utc,
      accepted: boolean,
    ) => OrchestrationV2ThreadShell,
  ): typeof command {
    return {
      label: command.label,
      run: async (registry, target) => {
        const now = DateTime.nowUnsafe();
        const pending = pendingAtom(target.environmentId);
        const source = sourceSnapshotAtom(target.environmentId);
        const update: PendingThreadUpdate = {
          threadId: target.input.threadId,
          apply: (thread) => apply(thread, target.input, now, update.sequence !== undefined),
        };
        const remove = () =>
          registry.update(pending, (current) => current.filter((item) => item !== update));
        const confirm = (sequence: number) => {
          update.sequence = sequence;
          registry.update(pending, (current) => [...current]);
          const reconcile = (snapshot: OrchestrationV2ShellSnapshot | null) => {
            if (snapshot === null || snapshot.snapshotSequence >= sequence) {
              remove();
              unsubscribe();
            }
          };
          const unsubscribe = registry.subscribe(source, reconcile);
          reconcile(registry.get(source));
        };
        registry.update(pending, (current) => [...current, update]);
        let kept = false;
        try {
          const result = await command.run(registry, target);
          if (result._tag === "Success") {
            const value = result.value;
            if ("sent" in value) {
              value.sent.addObserver((exit) =>
                Exit.isSuccess(exit) ? confirm(exit.value.sequence) : remove(),
              );
            } else {
              confirm(value.sequence);
            }
            kept = true;
          }
          return result;
        } finally {
          if (!kept) remove();
        }
      },
    };
  }

  return { snapshotAtom, pendingThreadIdsAtom, wrap };
}
