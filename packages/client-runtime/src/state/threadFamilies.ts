import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";
import { arrayElementsEqual } from "./entities.ts";
import { createEnvironmentQueryAtomFamily, selectEnvironmentQueryData } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";

const EMPTY_FAMILY: OrchestrationV2ThreadFamily = { snapshotSequence: 0, threads: [] };
const EMPTY_READS: ReadonlyArray<OrchestrationV2ThreadFamily> = [];

interface MountedRows {
  readonly rows: Atom.Atom<ReadonlyArray<OrchestrationV2ThreadFamily>>;
  readonly count: number;
}
const EMPTY_MOUNTS: ReadonlyMap<string, MountedRows> = new Map();
// Generation 0 is the cached shell from before this session's first authoritative snapshot. A read
// for it would be thrown away once that snapshot lands, so it waits instead.
const AWAITING_AUTHORITATIVE_SHELL = AsyncResult.initial<never, never>(true);

/** Whether a family read can decide anything yet. Only a settled read can prove a thread is gone. */
export type ThreadFamilyRead = "pending" | "failed" | "settled";

export function threadFamilyRead(
  result: AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>,
): ThreadFamilyRead {
  // A failure whose retry is in flight is pending, so callers do not restart that retry.
  if (result.waiting) return "pending";
  if (AsyncResult.isFailure(result)) return "failed";
  return AsyncResult.isSuccess(result) ? "settled" : "pending";
}

/**
 * Family rows the shell does not have. A shell row is at least as new as any family copy, since
 * shell deltas carry every change; a family copy read before the shell removed that thread is
 * stale.
 */
export function threadFamilyRowsMissingFromShell(input: {
  readonly shellThreads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly families: ReadonlyArray<OrchestrationV2ThreadFamily>;
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}): ReadonlyArray<OrchestrationV2ThreadShell> {
  const present = new Set<ThreadId>(input.shellThreads.map((thread) => thread.id));
  const missing: OrchestrationV2ThreadShell[] = [];
  for (const family of input.families) {
    for (const thread of family.threads) {
      if (present.has(thread.id)) continue;
      if ((input.removedAt.get(thread.id) ?? -1) > family.snapshotSequence) continue;
      present.add(thread.id);
      missing.push(thread);
    }
  }
  return missing;
}

/**
 * Shells with `omitIdleSubagents` or `omitOlderSettled` leave rows to on-demand reads: a family is
 * every active thread sharing a `lineage.rootThreadId`, read once per shell generation; shelf pages
 * and search rows mount through `mountRows`. All merge behind shell rows, which win (deltas carry
 * every change), and are never persisted.
 */
export function createThreadFamilyAtoms<R, ER, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
) {
  const shellStateValue = (state: AsyncResult.AsyncResult<EnvironmentShellState, E>) =>
    Option.getOrNull(AsyncResult.value(state));
  const generationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => shellStateValue(get(shellStateAtom(environmentId)))?.generation ?? 0).pipe(
      Atom.withLabel(`environment-shell-generation:${environmentId}`),
    ),
  );

  // The generation is part of the key, so a read from before the latest authoritative snapshot is
  // never used again, even while a new read is pending or failed.
  const familyQueryAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:thread-family",
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 60_000,
    execute: Effect.fn("ThreadFamilies.read")(function* (input: {
      readonly threadId: ThreadId;
      readonly generation: number;
    }) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const session = yield* SubscriptionRef.get(supervisor.session);
      if (Option.isNone(session)) {
        return yield* new EnvironmentRpcUnavailableError({
          environmentId: supervisor.target.environmentId,
          message: "The environment has no session.",
        });
      }
      // A config failure fails the read: an empty family would read as "the thread is gone".
      const config = yield* session.value.initialConfig;
      // Servers without families send every child in the shell, so absent means gone.
      if (config.shellThreadFamilies !== true) return EMPTY_FAMILY;
      return yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadFamily, {
        threadId: input.threadId,
      });
    }),
  });
  const queryFor = (environmentId: EnvironmentId, threadId: ThreadId, generation: number) =>
    familyQueryAtom({ environmentId, input: { threadId, generation } });

  const familyAtom = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get) => {
      const generation = get(generationAtom(environmentId));
      return generation === 0
        ? AWAITING_AUTHORITATIVE_SHELL
        : get(queryFor(environmentId, threadId, generation));
    }).pipe(Atom.withLabel(`environment-thread-family:${key}`));
  });
  const familyKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
    JSON.stringify([environmentId, threadId]);

  /** Reads the current generation's family again, so a failed read does not last the session. */
  const refresh = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => {
    const generation = registry.get(generationAtom(environmentId));
    if (generation !== 0) registry.refresh(queryFor(environmentId, threadId, generation));
  };

  const mountsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(EMPTY_MOUNTS).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-thread-family-mounts:${environmentId}`),
    ),
  );

  const familyRowsAtom = Atom.family((key: string) =>
    Atom.make((get): ReadonlyArray<OrchestrationV2ThreadFamily> => {
      const family = selectEnvironmentQueryData(get(familyAtom(key)));
      return family === null ? EMPTY_READS : [family];
    }).pipe(Atom.withLabel(`environment-thread-family-rows:${key}`)),
  );

  /**
   * Merges `rows` behind the shell rows until the returned release runs. Reads read under `key`
   * share one entry; each read's `snapshotSequence` decides which removals drop its rows.
   */
  const mountRows = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    key: string,
    rows: Atom.Atom<ReadonlyArray<OrchestrationV2ThreadFamily>>,
  ): (() => void) => {
    const atom = mountsAtom(environmentId);
    const mounts = registry.get(atom);
    const entry = mounts.get(key);
    registry.set(
      atom,
      new Map(mounts).set(key, { rows: entry?.rows ?? rows, count: (entry?.count ?? 0) + 1 }),
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = new Map(registry.get(atom));
      const entry = next.get(key);
      if (entry !== undefined && entry.count > 1)
        next.set(key, { ...entry, count: entry.count - 1 });
      else next.delete(key);
      registry.set(atom, next);
    };
  };

  /** Keeps a thread's family in the merged rows until the returned release runs. */
  const mount = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ): (() => void) => {
    const key = familyKey(environmentId, threadId);
    const release = mountRows(registry, environmentId, `family:${key}`, familyRowsAtom(key));
    // Mounting again after a failure retries instead of keeping the failure until reconnect.
    if (threadFamilyRead(registry.get(familyAtom(key))) === "failed") {
      refresh(registry, environmentId, threadId);
    }
    return release;
  };

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly removedAt: ReadonlyMap<ThreadId, number>;
      readonly families: ReadonlyArray<OrchestrationV2ThreadFamily>;
      readonly merged: OrchestrationV2ShellSnapshot;
    } | null = null;
    return Atom.make((get): OrchestrationV2ShellSnapshot | null => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const snapshot = state === null ? null : Option.getOrNull(state.snapshot);
      const mounts = get(mountsAtom(environmentId));
      if (snapshot === null || state === null || mounts.size === 0) return snapshot;
      // A read from before the latest authoritative snapshot can hold threads removed before it,
      // and that snapshot cleared those removals; such reads (a cached search) wait for new ones.
      const cut = snapshot.olderSettled?.asOfSequence ?? 0;
      const families = [...mounts.values()].flatMap(({ rows }) =>
        get(rows).filter((read) => read.snapshotSequence >= cut),
      );
      // Most shell updates move only the cursor. With the same rows, removals and families, keep
      // the merged rows so thread lists skip their rebuild.
      const unchanged =
        previous !== null &&
        previous.snapshot.threads === snapshot.threads &&
        previous.removedAt === state.removedAt &&
        arrayElementsEqual(previous.families, families);
      if (unchanged && previous !== null && previous.snapshot === snapshot) return previous.merged;
      let merged: OrchestrationV2ShellSnapshot;
      if (unchanged && previous !== null) {
        merged =
          previous.merged === previous.snapshot
            ? snapshot
            : { ...snapshot, threads: previous.merged.threads };
      } else {
        const extras = threadFamilyRowsMissingFromShell({
          shellThreads: snapshot.threads,
          removedAt: state.removedAt,
          families,
        });
        merged =
          extras.length === 0
            ? snapshot
            : { ...snapshot, threads: [...snapshot.threads, ...extras] };
      }
      previous = { snapshot, removedAt: state.removedAt, families, merged };
      return merged;
    }).pipe(Atom.withLabel(`environment-snapshot-with-families:${environmentId}`));
  });

  return {
    /** The shell snapshot plus the rows of every mounted family. */
    snapshotAtom,
    /** The current generation's family read, for decisions that need a settled answer. */
    familyAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      familyAtom(familyKey(environmentId, threadId)),
    mount,
    mountRows,
    refresh,
  };
}
