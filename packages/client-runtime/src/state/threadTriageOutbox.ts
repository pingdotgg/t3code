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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  type PendingThreadTriage,
  type PendingThreadTriages,
  ThreadTriageOutboxStore,
  type ThreadTriageOutboxStorageError,
} from "../platform/threadTriageOutboxStore.ts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "../rpc/client.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { type AtomCommand, type AtomCommandResult, createRuntimeCommand } from "./runtime.ts";

type Target<I> = { readonly environmentId: EnvironmentId; readonly input: I };
type Change = (stored: PendingThreadTriages, newCommandId: CommandId) => PendingThreadTriages;

const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);

/** Failures that say nothing about whether the server would accept the change. */
function isTransient(cause: Cause.Cause<unknown>) {
  return (
    Cause.hasInterruptsOnly(cause) ||
    cause.reasons.some(
      (reason) =>
        !Cause.isFailReason(reason) ||
        isUnavailable(reason.error) ||
        isRpcClientError(reason.error),
    )
  );
}

/** What the user acted on. A thread that shows otherwise on reconnect keeps its server state. */
function seenState(thread: OrchestrationV2ThreadShell) {
  return JSON.stringify([
    thread.latestRunId,
    thread.status,
    thread.itemCount,
    thread.pendingRuntimeRequest?.id ?? null,
    thread.settledOverride,
    thread.snoozedUntil == null ? null : DateTime.toEpochMillis(thread.snoozedUntil),
    thread.pinnedAt != null,
  ]);
}

const without = (entries: PendingThreadTriages, commandId: CommandId) =>
  entries.some((entry) => entry.commandId === commandId)
    ? entries.filter((entry) => entry.commandId !== commandId)
    : entries;

const sameEntries = (a: PendingThreadTriages, b: PendingThreadTriages) =>
  a.length === b.length &&
  a.every(
    (entry, index) =>
      entry.commandId === b[index]!.commandId && entry.attempted === b[index]!.attempted,
  );

/**
 * Settle and snooze for an environment that is not connected: the change is stored on the
 * device, shown at once, and sent when the environment is back. Storage is the truth: memory
 * mirrors what the last write returned, and a change is confirmed there right before it is sent.
 */
export function createThreadTriageOutbox<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<SecureRandom.SecureRandom | R, E>;
  readonly sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  /** Queued changes are sent once this reports a synchronized shell; without it, never. */
  readonly shellStatusAtom?: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellStatus>;
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
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}) {
  const update = createRuntimeCommand(input.runtime, {
    label: "environment-data:thread-triage-outbox",
    execute: Effect.fn("ThreadTriageOutbox.update")(function* (change: Change) {
      const store = yield* ThreadTriageOutboxStore;
      const random = yield* SecureRandom.SecureRandom;
      const newCommandId = CommandId.make(yield* random.uuidV4());
      return yield* store
        .update((stored) => change(stored, newCommandId))
        .pipe(
          Effect.tapError(() =>
            Effect.logWarning("Could not read or save offline thread changes.", {
              reason: "storage",
            }),
          ),
        );
    }),
  });

  const entriesAtom = Atom.make<PendingThreadTriages | null>(null).pipe(Atom.keepAlive);
  /** Ends with the registry, so a replay in flight stops touching it. */
  const lifetimeAtom = Atom.make((get) => {
    const lifetime = { ended: false };
    get.addFinalizer(() => {
      lifetime.ended = true;
    });
    return lifetime;
  }).pipe(Atom.keepAlive);

  const write = async (
    registry: AtomRegistry.AtomRegistry,
    change: Change = (stored) => stored,
  ) => {
    const lifetime = registry.get(lifetimeAtom);
    const result = await update.run(registry, change);
    if (AsyncResult.isSuccess(result) && !lifetime.ended) {
      const current = registry.get(entriesAtom);
      // An unchanged queue must not wake the replay that just read it.
      if (current === null || !sameEntries(current, result.value)) {
        registry.set(entriesAtom, result.value);
      }
    }
    return result;
  };
  const forget = (registry: AtomRegistry.AtomRegistry, entry: PendingThreadTriage) =>
    write(registry, (stored) => without(stored, entry.commandId));

  let loading: Promise<unknown> | undefined;
  const load = (registry: AtomRegistry.AtomRegistry) => (loading ??= write(registry));
  const environmentEntriesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const entries = get(entriesAtom);
      if (entries === null) void load(get.registry);
      return (entries ?? []).filter((entry) => entry.environmentId === environmentId);
    }),
  );
  const pendingFor = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) =>
    registry
      .get(entriesAtom)
      ?.find((entry) => entry.environmentId === environmentId && entry.threadId === threadId);
  const sourceThread = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) =>
    registry
      .get(input.sourceSnapshotAtom(environmentId))
      ?.threads.find((thread) => thread.id === threadId);

  const replaying = new Set<EnvironmentId>();
  const replayAgain = new Set<EnvironmentId>();
  const isLive = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    input.shellStatusAtom !== undefined &&
    registry.get(input.shellStatusAtom(environmentId)) === "live";
  const replay = async (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    if (replaying.has(environmentId)) {
      replayAgain.add(environmentId);
      return;
    }
    const lifetime = registry.get(lifetimeAtom);
    replaying.add(environmentId);
    try {
      await replayEntries(registry, environmentId, lifetime);
    } finally {
      replaying.delete(environmentId);
    }
    if (!lifetime.ended && replayAgain.delete(environmentId) && isLive(registry, environmentId)) {
      await replay(registry, environmentId);
    }
  };
  const replayEntries = async (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    lifetime: { readonly ended: boolean },
  ) => {
    for (const entry of registry.get(entriesAtom) ?? []) {
      if (lifetime.ended) return;
      if (entry.environmentId !== environmentId) continue;
      const thread = sourceThread(registry, environmentId, entry.threadId);
      // The live shell is the server's state. It wins over a change made against an older one,
      // which also covers a change that was sent before but whose reply was lost.
      if (
        thread === undefined ||
        seenState(thread) !== entry.seen ||
        input.apply(thread, entry.action, DateTime.nowUnsafe()) === thread
      ) {
        await forget(registry, entry);
        continue;
      }
      // Marked before sending, so an Undo after a lost reply or a restart asks the server.
      const marked = await write(registry, (current) =>
        current.some((item) => item.commandId === entry.commandId && item.attempted !== true)
          ? current.map((item) =>
              item.commandId === entry.commandId ? { ...item, attempted: true as const } : item,
            )
          : current,
      );
      if (lifetime.ended || !AsyncResult.isSuccess(marked)) return;
      // Storage no longer has it: cancelled, replaced, sent by another tab, or its environment
      // was removed.
      if (!marked.value.some((item) => item.commandId === entry.commandId)) continue;
      const result = await input.send(registry, entry);
      if (lifetime.ended || (!AsyncResult.isSuccess(result) && isTransient(result.cause))) return;
      await forget(registry, entry);
    }
  };
  const replayAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const entries = get(environmentEntriesAtom(environmentId));
      if (
        entries.length > 0 &&
        input.shellStatusAtom !== undefined &&
        get(input.shellStatusAtom(environmentId)) === "live"
      )
        void replay(get.registry, environmentId);
    }),
  );

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get.mount(replayAtom(environmentId));
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

  /** Queues the action on the device when its environment is not connected. */
  function queueWhenOffline<I extends { readonly threadId: ThreadId }, CE>(
    command: AtomCommand<Target<I>, { readonly sequence: number }, CE>,
    toAction: (input: I) => PendingThreadTriage["action"],
  ): typeof command {
    return {
      label: command.label,
      run: async (registry, target) => {
        const { environmentId } = target;
        const { threadId } = target.input;
        // Read before sending: the change is judged against what the user saw when acting.
        const snapshot = registry.get(input.sourceSnapshotAtom(environmentId));
        const thread = snapshot?.threads.find((candidate) => candidate.id === threadId);
        const result = await command.run(registry, target);
        if (AsyncResult.isSuccess(result)) {
          // The server now has a newer action than the queued one.
          const previous = pendingFor(registry, environmentId, threadId);
          if (previous !== undefined) await forget(registry, previous);
          return result;
        }
        const offline = result.cause.reasons.some(
          (reason) => Cause.isFailReason(reason) && isUnavailable(reason.error),
        );
        if (!offline || snapshot == null || thread === undefined) return result;
        await load(registry);
        const action = toAction(target.input);
        const queuedAt = DateTime.nowUnsafe();
        if (
          input.apply(thread, action, queuedAt) === thread ||
          // One change per thread. A snooze cannot replace a settle, which online it keeps.
          (action.type === "snooze" &&
            pendingFor(registry, environmentId, threadId)?.action.type === "settle")
        )
          return result;
        const queued = await write(registry, (stored, commandId) => [
          ...stored.filter(
            (entry) => entry.environmentId !== environmentId || entry.threadId !== threadId,
          ),
          { environmentId, threadId, commandId, action, queuedAt, seen: seenState(thread) },
        ]);
        return AsyncResult.isSuccess(queued)
          ? AsyncResult.success({ sequence: snapshot.snapshotSequence })
          : result;
      },
    };
  }

  /**
   * Undo of a change that was never sent cancels it on the device. Once it was sent, even if the
   * reply was lost, only the server can undo it.
   */
  function cancelQueued<I extends { readonly threadId: ThreadId }, A, B, CE>(
    command: AtomCommand<Target<I>, A, CE>,
    cancels: PendingThreadTriage["action"]["type"],
    cancelledValue: B,
  ): AtomCommand<Target<I>, A | B, CE | ThreadTriageOutboxStorageError | E> {
    return {
      label: command.label,
      run: async (registry, target) => {
        const pending = pendingFor(registry, target.environmentId, target.input.threadId);
        if (pending === undefined || pending.action.type !== cancels) {
          return command.run(registry, target);
        }
        // Storage decides, because a replay, a restart or another tab may have sent it.
        let unsent = false;
        const stored = await write(registry, (current) => {
          unsent = current.some(
            (entry) => entry.commandId === pending.commandId && entry.attempted !== true,
          );
          return unsent ? without(current, pending.commandId) : current;
        });
        if (!AsyncResult.isSuccess(stored)) return AsyncResult.failure(stored.cause);
        if (unsent) return AsyncResult.success(cancelledValue);
        const result = await command.run(registry, target);
        if (AsyncResult.isSuccess(result)) await forget(registry, pending);
        return result;
      },
    };
  }

  return { snapshotAtom, pendingSyncAtom, queueWhenOffline, cancelQueued };
}
