import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  type PendingThreadTriage,
  type ThreadTriageKey,
  type ThreadTriageOutboxDocument,
  sameThreadTriage,
  ThreadTriageOutboxStore,
  type ThreadTriageOutboxStorageError,
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

type StoreOperation =
  | { readonly _tag: "load" | "refresh" }
  | {
      readonly _tag: "put";
      readonly entry: Omit<PendingThreadTriage, "commandId">;
      readonly stillCurrent: () => boolean;
    }
  | { readonly _tag: "remove"; readonly entry: PendingThreadTriage }
  | { readonly _tag: "markAttempted"; readonly key: ThreadTriageKey }
  | {
      readonly _tag: "setOperable";
      readonly environmentId: EnvironmentId;
      readonly operable: boolean;
      readonly stillCurrent: () => boolean;
    };

const EMPTY_DOCUMENT: ThreadTriageOutboxDocument = { entries: [], operableEnvironmentIds: [] };

const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);
const isGuardUnsupported = Schema.is(ThreadVersionGuardUnsupportedError);

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

export function createThreadTriageOutbox<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<Crypto.Crypto | R, E>;
  readonly sourceSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  /** Replay waits for a synchronized shell; without one, nothing replays. */
  readonly shellStatusAtom?: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellStatus>;
  /** Whether the loaded session can change threads; null until it loads. */
  readonly operateScopeAtom?: (environmentId: EnvironmentId) => Atom.Atom<boolean | null>;
  /**
   * Whether the environment is registered; null until the catalog loads. Only a registered
   * environment's session may be remembered, so a removed one's late session grants nothing.
   */
  readonly registeredAtom?: (environmentId: EnvironmentId) => Atom.Atom<boolean | null>;
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
          const crypto = yield* Crypto.Crypto;
          const entry = {
            ...operation.entry,
            commandId: CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
          };
          yield* outbox.put(entry, operation.stillCurrent).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not save an offline thread change.", {
                cause: String(error.cause),
              }),
            ),
          );
          return { ...EMPTY_DOCUMENT, entries: [entry] };
        }
        case "remove":
          yield* outbox.remove(operation.entry).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not remove an offline thread change.", {
                cause: String(error.cause),
              }),
            ),
          );
          return EMPTY_DOCUMENT;
        case "markAttempted": {
          const marked = yield* outbox.markAttempted(operation.key).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("Could not record an offline thread change as sent.", {
                cause: String(error.cause),
              }),
            ),
          );
          return { ...EMPTY_DOCUMENT, entries: marked === undefined ? [] : [marked] };
        }
        case "setOperable":
          yield* outbox
            .setOperable(operation.environmentId, operation.operable, operation.stillCurrent)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not remember thread permissions.", {
                  cause: String(error.cause),
                }),
              ),
            );
          return EMPTY_DOCUMENT;
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

  /** Bumped when an environment is removed so in-flight work does not re-add its entries. */
  const generations = new Map<EnvironmentId, number>();
  const documentAtom = Atom.make<ThreadTriageOutboxDocument | null>(null).pipe(Atom.keepAlive);
  let loading: Promise<ThreadTriageOutboxDocument> | undefined;
  const ensureLoaded = (registry: AtomRegistry.AtomRegistry) => {
    const loaded = registry.get(documentAtom);
    if (loaded !== null) return Promise.resolve(loaded);
    if (loading !== undefined) return loading;
    const loadStarted = new Map(generations);
    loading = store.run(registry, { _tag: "load" }).then((result) => {
      const loadedDocument = AsyncResult.isSuccess(result) ? result.value : EMPTY_DOCUMENT;
      // An environment removed while the read was in flight must not come back from it.
      const removed = (environmentId: EnvironmentId) =>
        (generations.get(environmentId) ?? 0) !== (loadStarted.get(environmentId) ?? 0);
      const current = registry.get(documentAtom) ?? {
        entries: loadedDocument.entries.filter((entry) => !removed(entry.environmentId)),
        operableEnvironmentIds: loadedDocument.operableEnvironmentIds.filter((id) => !removed(id)),
      };
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

  /** One owner per thread at a time: a replay, an Undo, or a replacing action. */
  const claimed = new Set<string>();
  const clearLocal = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    generations.set(environmentId, (generations.get(environmentId) ?? 0) + 1);
    const document = registry.get(documentAtom);
    if (document === null) return;
    registry.set(documentAtom, {
      entries: document.entries.filter((entry) => entry.environmentId !== environmentId),
      operableEnvironmentIds: document.operableEnvironmentIds.filter((id) => id !== environmentId),
    });
  };
  const keyOf = (entry: ThreadTriageKey) => JSON.stringify([entry.environmentId, entry.threadId]);
  const pendingFor = (registry: AtomRegistry.AtomRegistry, key: ThreadTriageKey) =>
    registry.get(documentAtom)?.entries.find((entry) => sameThreadTriage(entry, key));
  const setLocal = (
    registry: AtomRegistry.AtomRegistry,
    transform: (entries: ReadonlyArray<PendingThreadTriage>) => ReadonlyArray<PendingThreadTriage>,
  ) => {
    const document = registry.get(documentAtom) ?? EMPTY_DOCUMENT;
    registry.set(documentAtom, { ...document, entries: transform(document.entries) });
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
  const forget = async (registry: AtomRegistry.AtomRegistry, entry: PendingThreadTriage) => {
    const lifetime = registry.get(registryLifetimeAtom);
    const removed = await store.run(registry, { _tag: "remove", entry });
    if (!lifetime.ended) {
      setLocal(registry, (entries) => entries.filter((current) => current !== entry));
    }
    return removed;
  };

  /** Reconnect skips a claimed thread, so whoever releases one replays what is still queued. */
  const release = (
    registry: AtomRegistry.AtomRegistry,
    key: ThreadTriageKey,
    lifetime: { readonly ended: boolean },
  ) => {
    claimed.delete(keyOf(key));
    if (
      !lifetime.ended &&
      input.shellStatusAtom !== undefined &&
      registry.get(input.shellStatusAtom(key.environmentId)) === "live" &&
      pendingFor(registry, key) !== undefined
    ) {
      void replay(registry, key.environmentId);
    }
  };

  const replayingEnvironments = new Set<EnvironmentId>();
  const replayAgain = new Set<EnvironmentId>();
  const replay = async (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    if (replayingEnvironments.has(environmentId)) {
      replayAgain.add(environmentId);
      return;
    }
    const lifetime = registry.get(registryLifetimeAtom);
    replayingEnvironments.add(environmentId);
    try {
      await replayEntries(registry, environmentId, lifetime);
    } finally {
      replayingEnvironments.delete(environmentId);
    }
    if (lifetime.ended) return;
    if (replayAgain.delete(environmentId) && input.shellStatusAtom !== undefined) {
      if (registry.get(input.shellStatusAtom(environmentId)) === "live") {
        await replay(registry, environmentId);
      }
    }
  };
  const replayEntries = async (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    lifetime: { readonly ended: boolean },
  ) => {
    for (const { threadId } of registry.get(environmentEntriesAtom(environmentId))) {
      // Earlier replies may have let Undo, a replacement, or a removal change this entry.
      const entry = pendingFor(registry, { environmentId, threadId });
      if (entry === undefined) continue;
      const key = keyOf(entry);
      if (claimed.has(key)) continue;
      claimed.add(key);
      try {
        // Marked before sending, so an Undo after a lost reply, a restart, or in another tab asks
        // the server. Storage also shows whether another tab cancelled or replaced the change.
        const marked = await store.run(registry, { _tag: "markAttempted", key: entry });
        if (lifetime.ended || !AsyncResult.isSuccess(marked)) return;
        if (pendingFor(registry, entry) !== entry) continue;
        const stored = marked.value.entries[0];
        if (stored === undefined) {
          setLocal(registry, (entries) => entries.filter((existing) => existing !== entry));
          continue;
        }
        const current = stored.commandId === entry.commandId ? entry : stored;
        if (current !== entry) {
          setLocal(registry, (entries) =>
            entries.map((existing) => (existing === entry ? current : existing)),
          );
        }
        // Expiry belongs to the change actually sent, which may be another tab's replacement.
        if (
          current.action.type === "snooze" &&
          !(Date.parse(current.action.snoozedUntil) > DateTime.toEpochMillis(DateTime.nowUnsafe()))
        ) {
          await forget(registry, current);
          if (lifetime.ended) return;
          continue;
        }
        const result = await input.replay(registry, current);
        if (lifetime.ended) return;
        if (AsyncResult.isSuccess(result) || !isTransient(result.cause)) {
          await forget(registry, current);
          if (lifetime.ended) return;
        } else {
          return;
        }
      } finally {
        claimed.delete(key);
      }
    }
  };

  const reconnectAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      if (
        input.shellStatusAtom === undefined ||
        get(input.shellStatusAtom(environmentId)) !== "live"
      )
        return;
      const registry = get.registry;
      const lifetime = registry.get(registryLifetimeAtom);
      const generation = generations.get(environmentId) ?? 0;
      void ensureLoaded(registry).then(async () => {
        if (lifetime.ended || (generations.get(environmentId) ?? 0) !== generation) return;
        const result = await store.run(registry, { _tag: "refresh" });
        if (
          lifetime.ended ||
          (generations.get(environmentId) ?? 0) !== generation ||
          !AsyncResult.isSuccess(result)
        )
          return;
        // A reconnect also discovers actions queued by a tab that has since closed.
        setLocal(registry, (entries) => {
          const next = [
            ...entries.filter(
              (entry) => entry.environmentId !== environmentId || claimed.has(keyOf(entry)),
            ),
            ...result.value.entries
              .filter(
                (entry) => entry.environmentId === environmentId && !claimed.has(keyOf(entry)),
              )
              .map(
                (entry) =>
                  entries.find(
                    (current) =>
                      sameThreadTriage(current, entry) && current.commandId === entry.commandId,
                  ) ?? entry,
              ),
          ];
          return next.length === entries.length &&
            next.every((entry, index) => entry === entries[index])
            ? entries
            : next;
        });
      });
    }),
  );

  const replayAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const status = input.shellStatusAtom ? get(input.shellStatusAtom(environmentId)) : "empty";
      const entries = get(environmentEntriesAtom(environmentId));
      if (status === "live" && entries.length > 0) void replay(get.registry, environmentId);
    }),
  );

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get.mount(reconnectAtom(environmentId));
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
  ): Command<I, CE | ThreadVersionGuardUnsupportedError> {
    return {
      label: command.label,
      run: async (registry, target) => {
        const { environmentId } = target;
        const key = { environmentId, threadId: target.input.threadId };
        const claimKey = keyOf(key);
        const lifetime = registry.get(registryLifetimeAtom);
        // A replay already holding the thread finishes first; the scheduler runs this after it.
        const owns = !claimed.has(claimKey);
        if (owns) claimed.add(claimKey);
        const generation = generations.get(environmentId) ?? 0;
        const current = () => (generations.get(environmentId) ?? 0) === generation;
        // The server compares against what the user saw when acting, not what arrives later.
        const snapshot = registry.get(input.sourceSnapshotAtom(environmentId));
        const thread = snapshot?.threads.find((candidate) => candidate.id === key.threadId);
        const superseded = pendingFor(registry, key);
        const guarded =
          (input.serverConfigAtom ? registry.get(input.serverConfigAtom(environmentId)) : null)
            ?.environment.capabilities.threadTriageVersionGuard === true;
        try {
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
            // The server now has a newer action, which the change it replaced would only fight.
            // A change queued after this one started stays, and one a replay holds is left to it.
            const previous = pendingFor(registry, key);
            if (
              previous !== undefined &&
              previous === superseded &&
              (owns || !claimed.has(claimKey))
            ) {
              await forget(registry, previous);
            }
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
          if (snapshot == null || thread === undefined || !current()) return result;
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
              action: action(target.input),
              queuedAt: DateTime.nowUnsafe(),
              snapshotSequence: snapshot.snapshotSequence,
            },
            stillCurrent: current,
          });
          // A removal before the write skipped it; one after it already deleted the entry.
          if (!AsyncResult.isSuccess(queued) || !current()) return result;
          const entry = queued.value.entries[0]!;
          setLocal(registry, (entries) => [
            ...entries.filter((existing) => !sameThreadTriage(existing, entry)),
            entry,
          ]);
          return AsyncResult.success({ sequence: snapshot.snapshotSequence, pendingSync: true });
        } finally {
          if (owns) release(registry, key, lifetime);
        }
      },
    };
  }

  /** Undo before sync cancels the queued action instead of asking the server. */
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
        const claimKey = pending === undefined ? undefined : keyOf(pending);
        if (
          pending === undefined ||
          claimKey === undefined ||
          pending.action.type !== cancels ||
          claimed.has(claimKey)
        ) {
          // A claimed entry may already be on its way; the server undoes it after it lands.
          const result = await command.run(registry, target);
          if (
            AsyncResult.isSuccess(result) &&
            pending !== undefined &&
            pending.action.type === cancels &&
            pendingFor(registry, pending) === pending
          ) {
            await forget(registry, pending);
          }
          return result;
        }
        const lifetime = registry.get(registryLifetimeAtom);
        claimed.add(claimKey);
        try {
          // Storage decides, because another tab or an earlier run may have sent it.
          const outcome = await cancelStored.run(registry, pending);
          if (!AsyncResult.isSuccess(outcome)) return AsyncResult.failure(outcome.cause);
          if (outcome.value !== "attempted") {
            setLocal(registry, (entries) => entries.filter((current) => current !== pending));
          }
          if (outcome.value === "cancelled") return AsyncResult.success(cancelledValue);
          const result = await command.run(registry, target);
          // The undo is newer on the server, which then rejects the queued change anyway.
          if (AsyncResult.isSuccess(result) && pendingFor(registry, pending) === pending) {
            await forget(registry, pending);
          }
          return result;
        } finally {
          release(registry, pending, lifetime);
        }
      },
    };
  }

  /**
   * Settle and snooze stay available offline only where the last loaded session could
   * change threads. A loaded session always decides, and replay is checked again by the server.
   */
  const offlineTriagePermittedAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const registeredAtom = input.registeredAtom?.(environmentId);
      const registered = registeredAtom === undefined ? true : get(registeredAtom);
      if (registered === false) return false;
      const known = input.operateScopeAtom ? get(input.operateScopeAtom(environmentId)) : null;
      const document = get(loadedDocumentAtom);
      const remembered = document?.operableEnvironmentIds.includes(environmentId) ?? false;
      if (known === null) return remembered;
      const generation = generations.get(environmentId) ?? 0;
      if (registered === true && document !== null && known !== remembered) {
        const registry = get.registry;
        registry.set(documentAtom, {
          ...document,
          operableEnvironmentIds: [
            ...document.operableEnvironmentIds.filter((id) => id !== environmentId),
            ...(known ? [environmentId] : []),
          ],
        });
        void store.run(registry, {
          _tag: "setOperable",
          environmentId,
          operable: known,
          // Checked inside the store's lock, after any removal that started first.
          stillCurrent: () =>
            (generations.get(environmentId) ?? 0) === generation &&
            (registeredAtom === undefined || registry.get(registeredAtom) === true),
        });
      }
      return known;
    }),
  );

  return {
    snapshotAtom,
    pendingSyncAtom,
    offlineTriagePermittedAtom,
    queueWhenOffline,
    cancelQueued,
  };
}
