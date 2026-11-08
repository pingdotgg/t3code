import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
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
  type ThreadTriageKey,
  type ThreadTriageOutboxDocument,
  sameThreadTriage,
  ThreadTriageOutboxStore,
  type ThreadTriageOutboxStorageError,
  ThreadTriagePendingSettleError,
} from "../platform/threadTriageOutboxStore.ts";
import { ThreadVersionGuardUnsupportedError } from "../operations/commands.ts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "../rpc/client.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { type AtomCommand, type AtomCommandResult, createRuntimeCommand } from "./runtime.ts";

type SettleOrSnoozeInput = {
  readonly threadId: ThreadId;
  readonly commandId?: CommandId;
  readonly snoozedUntil?: string;
  readonly snapshotSequence?: number;
};
type TriageResult = { readonly sequence: number; readonly pendingSync?: true };
type Command<I, E> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: I },
  TriageResult,
  E
>;
type StoredEntry = ThreadTriageKey & Pick<PendingThreadTriage, "commandId">;

type StoreOperation =
  | { readonly _tag: "load" | "refresh" }
  | { readonly _tag: "put"; readonly entry: Omit<PendingThreadTriage, "commandId"> }
  | { readonly _tag: "remove"; readonly entry: StoredEntry }
  | { readonly _tag: "markAttempted"; readonly entry: PendingThreadTriage };

const EMPTY_DOCUMENT: ThreadTriageOutboxDocument = { entries: [] };

const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);
const isGuardUnsupported = Schema.is(ThreadVersionGuardUnsupportedError);
const isPendingSettle = Schema.is(ThreadTriagePendingSettleError);

function offlineError(cause: Cause.Cause<unknown>) {
  const reason = cause.reasons.find(
    (candidate) => Cause.isFailReason(candidate) && isUnavailable(candidate.error),
  );
  return reason !== undefined && Cause.isFailReason(reason) && isUnavailable(reason.error)
    ? reason.error
    : undefined;
}

/**
 * Failures that say nothing about whether the server would accept the change. A server too old
 * to check the snapshot keeps the change queued until it is updated.
 */
function isTransient(cause: Cause.Cause<unknown>) {
  return (
    Cause.hasInterruptsOnly(cause) ||
    cause.reasons.some(
      (reason) =>
        !Cause.isFailReason(reason) ||
        isUnavailable(reason.error) ||
        isRpcClientError(reason.error) ||
        isGuardUnsupported(reason.error),
    )
  );
}

const sameEntry = (a: StoredEntry, b: StoredEntry) =>
  sameThreadTriage(a, b) && a.commandId === b.commandId;

/** Keeps the array when nothing changes, so a no-op does not wake the replay again. */
function withoutEntry(entries: ReadonlyArray<PendingThreadTriage>, entry: StoredEntry) {
  return entries.some((current) => sameEntry(current, entry))
    ? entries.filter((current) => !sameEntry(current, entry))
    : entries;
}

export function createThreadTriageOutbox<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<SecureRandom.SecureRandom | R, E>;
  readonly sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  /** Replay waits for a synchronized shell; without one, nothing replays. */
  readonly shellStatusAtom?: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellStatus>;
  /** Cached config; only servers that check the snapshot sequence get queued changes. */
  readonly serverConfigAtom?: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
  readonly applySettle: (
    thread: OrchestrationV2ThreadShell,
    queuedAt: DateTime.Utc,
  ) => OrchestrationV2ThreadShell;
  readonly applySnooze: (
    thread: OrchestrationV2ThreadShell,
    snoozedUntil: string,
    queuedAt: DateTime.Utc,
  ) => OrchestrationV2ThreadShell;
  /** Sends the queued action with its command id and snapshot sequence. */
  readonly replay: (
    registry: AtomRegistry.AtomRegistry,
    entry: PendingThreadTriage,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}) {
  const store = createRuntimeCommand(input.runtime, {
    label: "environment-data:thread-triage-outbox",
    execute: Effect.fn("ThreadTriageOutbox.store")(function* (
      operation: StoreOperation,
      registry: AtomRegistry.AtomRegistry,
    ) {
      const outbox = yield* ThreadTriageOutboxStore;
      const logFailure =
        (message: string) =>
        <A, R2>(effect: Effect.Effect<A, ThreadTriageOutboxStorageError, R2>) =>
          effect.pipe(
            Effect.tapError((error) => Effect.logWarning(message, { cause: String(error.cause) })),
          );
      switch (operation._tag) {
        case "refresh":
          return yield* outbox.load;
        case "load":
          outbox.subscribeCleared((environmentId) => clearLocal(registry, environmentId));
          return yield* outbox.load.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not load offline thread changes.", {
                cause: String(error.cause),
              }).pipe(Effect.as(EMPTY_DOCUMENT)),
            ),
          );
        case "put": {
          const random = yield* SecureRandom.SecureRandom;
          const entry = {
            ...operation.entry,
            commandId: CommandId.make(yield* random.uuidV4()),
          };
          yield* outbox.put(entry).pipe(
            Effect.tapError((error) =>
              error._tag === "ThreadTriagePendingSettleError"
                ? Effect.void
                : Effect.logWarning("Could not save an offline thread change.", {
                    cause: String(error.cause),
                  }),
            ),
          );
          return { entries: [entry] };
        }
        case "remove":
          yield* outbox
            .remove(operation.entry)
            .pipe(logFailure("Could not remove an offline thread change."));
          return EMPTY_DOCUMENT;
        case "markAttempted": {
          const marked = yield* outbox
            .markAttempted(operation.entry)
            .pipe(logFailure("Could not record an offline thread change as sent."));
          return { entries: marked ? [operation.entry] : [] };
        }
      }
    }),
  });

  const cancelStored = createRuntimeCommand(input.runtime, {
    label: "environment-data:thread-triage-outbox-cancel",
    execute: Effect.fn("ThreadTriageOutbox.cancel")(function* (entry: PendingThreadTriage) {
      const outbox = yield* ThreadTriageOutboxStore;
      return yield* outbox.cancel(entry).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not cancel an offline thread change.", {
            cause: String(error.cause),
          }),
        ),
      );
    }),
  });

  const documentAtom = Atom.make<ThreadTriageOutboxDocument | null>(null).pipe(Atom.keepAlive);
  let loading: Promise<ThreadTriageOutboxDocument> | undefined;
  const ensureLoaded = (registry: AtomRegistry.AtomRegistry) => {
    const loaded = registry.get(documentAtom);
    if (loaded !== null) return Promise.resolve(loaded);
    loading ??= store.run(registry, { _tag: "load" }).then((result) => {
      const current =
        registry.get(documentAtom) ??
        (AsyncResult.isSuccess(result) ? result.value : EMPTY_DOCUMENT);
      registry.set(documentAtom, current);
      return current;
    });
    return loading;
  };
  const loadedDocumentAtom = Atom.make((get) => {
    const loaded = get(documentAtom);
    if (loaded === null) void ensureLoaded(get.registry);
    return loaded;
  });

  const entriesAtom = Atom.make((get) => get(loadedDocumentAtom)?.entries ?? []);
  const environmentEntriesAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(entriesAtom).filter((entry) => entry.environmentId === environmentId)),
  );

  const pendingFor = (registry: AtomRegistry.AtomRegistry, key: ThreadTriageKey) =>
    registry.get(documentAtom)?.entries.find((entry) => sameThreadTriage(entry, key));
  const setLocal = (
    registry: AtomRegistry.AtomRegistry,
    transform: (entries: ReadonlyArray<PendingThreadTriage>) => ReadonlyArray<PendingThreadTriage>,
  ) => {
    const document = registry.get(documentAtom) ?? EMPTY_DOCUMENT;
    const entries = transform(document.entries);
    if (entries !== document.entries) registry.set(documentAtom, { entries });
  };
  /** Counts removals, so a queue write that lands after one is undone. */
  const removals = new Map<EnvironmentId, number>();
  const clearLocal = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    removals.set(environmentId, (removals.get(environmentId) ?? 0) + 1);
    if (registry.get(documentAtom) === null) return;
    setLocal(registry, (entries) =>
      entries.filter((entry) => entry.environmentId !== environmentId),
    );
  };
  /** Ends with the registry, so replay stops touching it once the app or a test tears it down. */
  const registryLifetimeAtom = Atom.make((get) => {
    const lifetime = { ended: false };
    get.addFinalizer(() => {
      lifetime.ended = true;
    });
    return lifetime;
  }).pipe(Atom.keepAlive);

  /**
   * Hides the entry even if storage keeps it: a restart then replays it with the same command
   * id, which the server deduplicates or rejects. Cancelling must check the result instead.
   */
  const forget = async (registry: AtomRegistry.AtomRegistry, entry: StoredEntry) => {
    const lifetime = registry.get(registryLifetimeAtom);
    const removed = await store.run(registry, { _tag: "remove", entry });
    if (!lifetime.ended) setLocal(registry, (entries) => withoutEntry(entries, entry));
    return removed;
  };

  /** Answered this session; storage that failed to drop one must not make replay send it again. */
  const answered = new Set<CommandId>();
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
    const lifetime = registry.get(registryLifetimeAtom);
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
    await ensureLoaded(registry);
    // Storage decides what to send: another tab may have queued, replaced, or cancelled a change.
    const loaded = await store.run(registry, { _tag: "refresh" });
    if (lifetime.ended || !AsyncResult.isSuccess(loaded)) return;
    const stored = loaded.value.entries.filter(
      (entry) => entry.environmentId === environmentId && !answered.has(entry.commandId),
    );
    setLocal(registry, (entries) => {
      const kept = entries.filter(
        (entry) =>
          entry.environmentId !== environmentId ||
          stored.some((candidate) => sameEntry(candidate, entry)),
      );
      const added = stored.filter((entry) => !entries.some((current) => sameEntry(current, entry)));
      return kept.length === entries.length && added.length === 0 ? entries : [...kept, ...added];
    });
    for (const entry of stored) {
      if (
        entry.action.type === "snooze" &&
        !(Date.parse(entry.action.snoozedUntil) > DateTime.toEpochMillis(DateTime.nowUnsafe()))
      ) {
        answered.add(entry.commandId);
        await forget(registry, entry);
        if (lifetime.ended) return;
        continue;
      }
      // Marked before sending, so an Undo after a lost reply or a restart asks the server.
      const marked = await store.run(registry, { _tag: "markAttempted", entry });
      if (lifetime.ended || !AsyncResult.isSuccess(marked)) return;
      // Cancelled or replaced after storage was read.
      if (marked.value.entries.length === 0) {
        setLocal(registry, (entries) => withoutEntry(entries, entry));
        continue;
      }
      const result = await input.replay(registry, entry);
      if (lifetime.ended) return;
      if (!AsyncResult.isSuccess(result) && isTransient(result.cause)) return;
      answered.add(entry.commandId);
      await forget(registry, entry);
      if (lifetime.ended) return;
    }
  };

  const replayAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get(environmentEntriesAtom(environmentId));
      if (
        input.shellStatusAtom !== undefined &&
        get(input.shellStatusAtom(environmentId)) === "live"
      )
        void replay(get.registry, environmentId);
    }),
  );

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get.mount(replayAtom(environmentId));
      // Loads the cached config before an offline action needs to read it.
      if (input.serverConfigAtom) get.mount(input.serverConfigAtom(environmentId));
      const snapshot = get(input.sourceSnapshotAtom(environmentId));
      const entries = get(environmentEntriesAtom(environmentId));
      if (snapshot === null || entries.length === 0) return snapshot;
      const byThread = new Map(entries.map((entry) => [entry.threadId, entry]));
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) => {
          const entry = byThread.get(thread.id);
          if (entry === undefined) return thread;
          return entry.action.type === "settle"
            ? input.applySettle(thread, entry.queuedAt)
            : input.applySnooze(thread, entry.action.snoozedUntil, entry.queuedAt);
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

  /** Queues the action locally when the environment is not connected. */
  function queueWhenOffline<I extends SettleOrSnoozeInput, CE>(
    command: Command<I, CE>,
    action: (input: I) => PendingThreadTriage["action"],
  ): Command<I, CE | ThreadVersionGuardUnsupportedError | ThreadTriagePendingSettleError> {
    return {
      label: command.label,
      run: async (registry, target) => {
        const { environmentId } = target;
        const key = { environmentId, threadId: target.input.threadId };
        const removalsBefore = removals.get(environmentId) ?? 0;
        // The server compares against what the user saw when acting, not what arrives later.
        const snapshot = registry.get(input.sourceSnapshotAtom(environmentId));
        const thread = snapshot?.threads.find((candidate) => candidate.id === key.threadId);
        const guarded =
          (input.serverConfigAtom ? registry.get(input.serverConfigAtom(environmentId)) : null)
            ?.environment.capabilities.threadTriageVersionGuard === true;
        // Started before any await so the optimistic change shows in the same frame.
        const result = await command.run(
          registry,
          snapshot !== null &&
            guarded &&
            input.shellStatusAtom !== undefined &&
            registry.get(input.shellStatusAtom(environmentId)) !== "live"
            ? {
                ...target,
                input: { ...target.input, snapshotSequence: snapshot.snapshotSequence },
              }
            : target,
        );
        if (AsyncResult.isSuccess(result)) {
          // The server has a newer action, so its guard would reject a queued one anyway.
          const previous = pendingFor(registry, key);
          if (previous !== undefined) await forget(registry, previous);
          return result;
        }
        const offline = offlineError(result.cause);
        if (offline === undefined) return result;
        if (!guarded) {
          return AsyncResult.failure(
            Cause.fail(
              new ThreadVersionGuardUnsupportedError({
                message: `${offline.message} Update its server to settle or snooze while it is offline.`,
              }),
            ),
          );
        }
        await ensureLoaded(registry);
        if (snapshot == null || thread === undefined) return result;
        const queuedAction = action(target.input);
        const now = DateTime.nowUnsafe();
        if (
          (queuedAction.type === "settle"
            ? input.applySettle(thread, now)
            : input.applySnooze(thread, queuedAction.snoozedUntil, now)) === thread
        )
          return result;
        // The put replaces any earlier entry for the thread, so a failed save keeps it.
        const queued = await store.run(registry, {
          _tag: "put",
          entry: {
            ...key,
            action: queuedAction,
            queuedAt: now,
            snapshotSequence: snapshot.snapshotSequence,
          },
        });
        if (!AsyncResult.isSuccess(queued)) {
          return queued.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && isPendingSettle(reason.error),
          )
            ? AsyncResult.failure(Cause.fail(new ThreadTriagePendingSettleError()))
            : result;
        }
        const entry = queued.value.entries[0]!;
        if ((removals.get(environmentId) ?? 0) !== removalsBefore) {
          await forget(registry, entry);
          return result;
        }
        setLocal(registry, (entries) => [
          ...entries.filter((existing) => !sameThreadTriage(existing, entry)),
          entry,
        ]);
        return AsyncResult.success({ sequence: snapshot.snapshotSequence, pendingSync: true });
      },
    };
  }

  /**
   * Undo of a change that was never sent cancels it locally. Once it was sent, even if the reply
   * was lost, only the server can undo it.
   */
  function cancelQueued<I extends { readonly threadId: ThreadId }, A, B, CE>(
    command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, CE>,
    cancels: PendingThreadTriage["action"]["type"],
    cancelledValue: B,
  ): AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: I },
    A | B,
    CE | ThreadTriageOutboxStorageError | E
  > {
    return {
      label: command.label,
      run: async (registry, target) => {
        const pending = pendingFor(registry, {
          environmentId: target.environmentId,
          threadId: target.input.threadId,
        });
        if (pending === undefined || pending.action.type !== cancels) {
          return command.run(registry, target);
        }
        // Storage decides, because a replay, a restart, or another tab may have sent it.
        const outcome = await cancelStored.run(registry, pending);
        if (!AsyncResult.isSuccess(outcome)) return AsyncResult.failure(outcome.cause);
        if (outcome.value !== "attempted") {
          setLocal(registry, (entries) => withoutEntry(entries, pending));
        }
        if (outcome.value === "cancelled") return AsyncResult.success(cancelledValue);
        const result = await command.run(registry, target);
        if (AsyncResult.isSuccess(result)) await forget(registry, pending);
        return result;
      },
    };
  }

  return {
    snapshotAtom,
    pendingSyncAtom,
    queueWhenOffline,
    cancelQueued,
  };
}
