import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import type { AtomCommand } from "./runtime.ts";

interface PendingThreadUpdate {
  readonly threadId: ThreadId;
  readonly apply: (thread: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell;
  sequence?: number;
  /**
   * A thread the command reaches only through a server-side follow-up, such as a settle cascade.
   * Its own event carries a sequence the client never learns, so the preview holds until the
   * thread itself shows a change made after the command started.
   */
  readonly settlesWhen?: (thread: OrchestrationV2ThreadShell) => boolean;
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
      { readonly sequence: number },
      E
    >,
    apply: (
      thread: OrchestrationV2ThreadShell,
      input: Input,
      now: DateTime.Utc,
      accepted: boolean,
    ) => OrchestrationV2ThreadShell,
    followers?: {
      /** Threads the server changes after this one commits, read from the shown snapshot. */
      readonly select: (
        snapshot: OrchestrationV2ShellSnapshot,
        input: Input,
      ) => ReadonlyArray<ThreadId>;
      readonly apply: (
        thread: OrchestrationV2ThreadShell,
        now: DateTime.Utc,
      ) => OrchestrationV2ThreadShell;
      /** The server's own state for the follower has landed. */
      readonly landed: (thread: OrchestrationV2ThreadShell, now: DateTime.Utc) => boolean;
    },
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
        const shown = registry.get(snapshotAtom(target.environmentId));
        const followerUpdates: ReadonlyArray<PendingThreadUpdate> =
          followers === undefined || shown === null
            ? []
            : followers.select(shown, target.input).map((threadId) => ({
                threadId,
                apply: (thread) =>
                  followers.landed(thread, now) ? thread : followers.apply(thread, now),
                settlesWhen: (thread) => followers.landed(thread, now),
              }));
        const remove = () =>
          registry.update(pending, (current) =>
            current.filter((item) => item !== update && !followerUpdates.includes(item)),
          );
        registry.update(pending, (current) => [...current, update, ...followerUpdates]);
        let confirmed = false;
        try {
          const result = await command.run(registry, target);
          if (result._tag === "Success" && followerUpdates.length > 0) {
            const prune = (snapshot: OrchestrationV2ShellSnapshot | null) => {
              const threads = new Map(
                (snapshot?.threads ?? []).map((thread) => [thread.id, thread]),
              );
              registry.update(pending, (current) =>
                current.filter((item) => {
                  if (item.settlesWhen === undefined || !followerUpdates.includes(item))
                    return true;
                  const thread = threads.get(item.threadId);
                  return thread !== undefined && !item.settlesWhen(thread);
                }),
              );
              if (!registry.get(pending).some((item) => followerUpdates.includes(item))) {
                stopPruning();
              }
            };
            const stopPruning = registry.subscribe(source, prune);
            prune(registry.get(source));
          }
          if (result._tag === "Success") {
            update.sequence = result.value.sequence;
            registry.update(pending, (current) => [...current]);
            const reconcile = (snapshot: OrchestrationV2ShellSnapshot | null) => {
              if (snapshot === null || snapshot.snapshotSequence >= result.value.sequence) {
                registry.update(pending, (current) => current.filter((item) => item !== update));
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

  return { snapshotAtom, pendingThreadIdsAtom, wrap };
}
