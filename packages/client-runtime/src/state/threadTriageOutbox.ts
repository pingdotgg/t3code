import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  type PendingThreadTriage,
  type PendingThreadTriages,
  ThreadTriageOutboxStore,
} from "../platform/threadTriageOutboxStore.ts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "../rpc/client.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { type AtomCommand, provideAtomRuntime } from "./runtime.ts";

type Target<I> = { readonly environmentId: EnvironmentId; readonly input: I };

const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** Failures that say nothing about whether the server would accept the change. */
const isTransient = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isInterruptReason(reason) ||
      (Cause.isFailReason(reason) &&
        (isUnavailable(reason.error) || isRpcClientError(reason.error))),
  );

/**
 * What the user acted on: the thread's work and every triage decision with its time. A rename,
 * tag change or visit is left out, so it does not drop the queued change.
 */
function seenState(thread: OrchestrationV2ThreadShell) {
  return JSON.stringify([
    thread.latestRunId,
    thread.status,
    thread.itemCount,
    thread.pendingRuntimeRequest?.id ?? null,
    thread.settledOverride,
    ...[
      thread.settledAt,
      thread.unsettledAt,
      thread.snoozedUntil,
      thread.snoozedAt,
      thread.pinnedAt,
    ].map((time) => (time == null ? null : DateTime.toEpochMillis(time))),
  ]);
}

const sameEntries = (a: PendingThreadTriages, b: PendingThreadTriages) =>
  a.length === b.length && a.every((entry, index) => entry.commandId === b[index]!.commandId);

/**
 * Settle and snooze for an environment that is not connected: the change is stored on the
 * device, shown at once, and sent when the environment's shell is synchronized again.
 */
export function createThreadTriageOutbox<R, E, SendError>(input: {
  readonly runtime: Atom.AtomRuntime<SecureRandom.SecureRandom | R, E>;
  readonly sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  readonly shellStatusAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellStatus>;
  /** Returns the thread itself when the action cannot apply to it. */
  readonly apply: (
    thread: OrchestrationV2ThreadShell,
    action: PendingThreadTriage["action"],
    queuedAt: DateTime.Utc,
  ) => OrchestrationV2ThreadShell;
  /** Sends the action under its command id, which the server answers only once. */
  readonly send: (
    registry: AtomRegistry.AtomRegistry,
    entry: PendingThreadTriage,
  ) => Effect.Effect<unknown, SendError>;
}) {
  const entriesAtom = Atom.make<PendingThreadTriages>([]).pipe(Atom.keepAlive);
  // Storage is shared with other tabs, so memory takes each result in the order storage gave it.
  const order = Semaphore.makeUnsafe(1);
  const update = Effect.fn("ThreadTriageOutbox.update")(function* (
    registry: AtomRegistry.AtomRegistry,
    change: (stored: PendingThreadTriages) => PendingThreadTriages,
  ) {
    const store = yield* ThreadTriageOutboxStore;
    return yield* store.update(change).pipe(
      Effect.tap((entries) =>
        Effect.sync(() => {
          if (!sameEntries(registry.get(entriesAtom), entries)) {
            registry.set(entriesAtom, entries);
          }
        }),
      ),
      order.withPermit,
    );
  });
  const read = (registry: AtomRegistry.AtomRegistry) => update(registry, (stored) => stored);

  const pendingFor = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) =>
    registry
      .get(entriesAtom)
      .find((entry) => entry.environmentId === environmentId && entry.threadId === threadId);
  /** Never fails: a change that stays stored is judged again on the next synchronized shell. */
  const forget = (registry: AtomRegistry.AtomRegistry, commandId: CommandId | undefined) =>
    commandId === undefined
      ? Effect.void
      : update(registry, (stored) =>
          stored.some((entry) => entry.commandId === commandId)
            ? stored.filter((entry) => entry.commandId !== commandId)
            : stored,
        ).pipe(provideAtomRuntime(registry, input.runtime), Effect.ignore);

  // The live shell is the server's state: it wins over a change made against an older one.
  const replay = Effect.fn("ThreadTriageOutbox.replay")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) {
    for (const entry of yield* read(registry)) {
      if (entry.environmentId !== environmentId) continue;
      // Read again: this or another tab may have cancelled or replaced it while an earlier
      // change was being sent.
      const stored = yield* read(registry);
      if (!stored.some((current) => current.commandId === entry.commandId)) continue;
      const thread = registry
        .get(input.sourceSnapshotAtom(environmentId))
        ?.threads.find((candidate) => candidate.id === entry.threadId);
      if (
        thread !== undefined &&
        seenState(thread) === entry.seen &&
        input.apply(thread, entry.action, DateTime.nowUnsafe()) !== thread
      ) {
        const sent = yield* Effect.exit(input.send(registry, entry));
        if (Exit.isFailure(sent) && isTransient(sent.cause)) continue;
      }
      yield* forget(registry, entry.commandId);
    }
  });
  // Rebuilt on each shell status, which stops a replay when the shell is no longer synchronized
  // and so keeps one replay per environment. Any other status only loads what is stored.
  const syncAtom = Atom.family((environmentId: EnvironmentId) =>
    input.runtime.atom((get) =>
      get(input.shellStatusAtom(environmentId)) === "live"
        ? replay(get.registry, environmentId)
        : Effect.asVoid(read(get.registry)),
    ),
  );
  const environmentEntriesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get.mount(syncAtom(environmentId));
      return get(entriesAtom).filter((entry) => entry.environmentId === environmentId);
    }),
  );

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const snapshot = get(input.sourceSnapshotAtom(environmentId));
      const entries = get(environmentEntriesAtom(environmentId));
      if (snapshot === null || entries.length === 0) return snapshot;
      const byThread = new Map(entries.map((entry) => [entry.threadId, entry]));
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) => {
          const entry = byThread.get(thread.id);
          return entry === undefined ? thread : input.apply(thread, entry.action, entry.queuedAt);
        }),
      };
    }),
  );

  const pendingSyncAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlySet<ThreadId> =>
        new Set(get(environmentEntriesAtom(environmentId)).map((entry) => entry.threadId)),
    ),
  );

  const queue = Effect.fn("ThreadTriageOutbox.queue")(function* (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    thread: OrchestrationV2ThreadShell,
    action: PendingThreadTriage["action"],
    queuedAt: DateTime.Utc,
  ) {
    const random = yield* SecureRandom.SecureRandom;
    const commandId = CommandId.make(yield* random.uuidV4());
    const stored = yield* update(registry, (current) => {
      const sameThread = (entry: PendingThreadTriage) =>
        entry.environmentId === environmentId && entry.threadId === thread.id;
      // One change per thread. A snooze cannot replace a settle, which online it keeps.
      return action.type === "snooze" && current.find(sameThread)?.action.type === "settle"
        ? current
        : [
            ...current.filter((entry) => !sameThread(entry)),
            {
              environmentId,
              threadId: thread.id,
              commandId,
              action,
              queuedAt,
              seen: seenState(thread),
            },
          ];
    });
    return stored.some((entry) => entry.commandId === commandId);
  });

  /** Queues the action on the device when its environment is not connected. */
  function queueWhenOffline<I extends { readonly threadId: ThreadId }, CE>(
    command: AtomCommand<Target<I>, { readonly sequence: number }, CE>,
    toAction: (input: I) => PendingThreadTriage["action"],
  ): typeof command {
    return {
      label: command.label,
      run: (registry, target) =>
        Effect.suspend(() => {
          const { environmentId } = target;
          const { threadId } = target.input;
          // Read before sending: the change is judged against what the user saw when acting.
          const snapshot = registry.get(input.sourceSnapshotAtom(environmentId));
          const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
          return command.run(registry, target).pipe(
            // The server now has a newer decision than the queued one.
            Effect.tap(() =>
              forget(registry, pendingFor(registry, environmentId, threadId)?.commandId),
            ),
            Effect.catchIf(isUnavailable, (unavailable) => {
              const action = toAction(target.input);
              const queuedAt = DateTime.nowUnsafe();
              if (
                snapshot == null ||
                thread === undefined ||
                input.apply(thread, action, queuedAt) === thread
              ) {
                return Effect.fail(unavailable);
              }
              return queue(registry, environmentId, thread, action, queuedAt).pipe(
                provideAtomRuntime(registry, input.runtime),
                Effect.exit,
                Effect.flatMap((queued) =>
                  Exit.isSuccess(queued) && queued.value
                    ? Effect.succeed({ sequence: snapshot.snapshotSequence })
                    : Effect.fail(unavailable),
                ),
              );
            }),
          );
        }),
    };
  }

  /**
   * Undo of a queued change removes it from storage first, so a replay that has not reached it
   * skips it; storage decides, so the change removed is the one stored now, also by another tab.
   * Offline that is the whole undo, reported as `cancelledOnDevice`. While the shell is
   * synchronized the environment is asked too, after any send already in its lane.
   */
  function cancelQueued<I extends { readonly threadId: ThreadId }, CE>(
    command: AtomCommand<Target<I>, { readonly sequence: number }, CE>,
    cancels: PendingThreadTriage["action"]["type"],
  ) {
    const cancelled = { sequence: 0, cancelledOnDevice: true } as const;
    return {
      label: command.label,
      run: (registry: AtomRegistry.AtomRegistry, target: Target<I>) =>
        Effect.suspend(() => {
          const { environmentId } = target;
          const { threadId } = target.input;
          const live = registry.get(input.shellStatusAtom(environmentId)) === "live";
          let removed = false;
          const remove = update(registry, (stored) => {
            const kept = stored.filter(
              (entry) =>
                entry.environmentId !== environmentId ||
                entry.threadId !== threadId ||
                entry.action.type !== cancels,
            );
            removed = kept.length !== stored.length;
            return removed ? kept : stored;
          }).pipe(provideAtomRuntime(registry, input.runtime));
          const sent = command.run(registry, target).pipe(
            Effect.tap(() =>
              forget(registry, pendingFor(registry, environmentId, threadId)?.commandId),
            ),
            // The connection dropped before the shell noticed, so nothing was sent.
            Effect.catchIf(isUnavailable, (unavailable) =>
              removed ? Effect.succeed(cancelled) : Effect.fail(unavailable),
            ),
          );
          return remove.pipe(
            Effect.flatMap(() => (removed && !live ? Effect.succeed(cancelled) : sent)),
          );
        }),
    };
  }

  return { snapshotAtom, pendingSyncAtom, queueWhenOffline, cancelQueued };
}
