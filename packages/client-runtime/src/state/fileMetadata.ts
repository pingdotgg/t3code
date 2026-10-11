import {
  FILESYSTEM_METADATA_BATCH_LIMIT,
  type EnvironmentId,
  type FilesystemEntryMetadata,
  type ProjectEntry,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  request,
  type EnvironmentRpcFailure,
  EnvironmentRpcUnavailableError,
} from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

const METADATA_STALE_TIME_MS = 60_000;
const METADATA_CACHE_LIMIT = 1024;

interface CachedMetadata {
  value: FilesystemEntryMetadata | null;
  expires: number;
}

type RetainedMetadata = Map<string, CachedMetadata>;

interface FileMetadataInput {
  path: string;
  threadId?: ThreadId;
}

class FileMetadataRequest extends Request.Class<
  {
    path: string;
    session: RpcSession;
    supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    retained?: RetainedMetadata;
  },
  FilesystemEntryMetadata | null,
  EnvironmentRpcFailure<typeof WS_METHODS.filesystemGetMetadata> | EnvironmentRpcUnavailableError
> {}

/** Shared by file chips, search results, and the file tree in one client. Cache
 * entries belong to an RPC session so reconnects and grant changes recheck them. */
export function createFileMetadataAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const cache = new WeakMap<RpcSession, Map<string, CachedMetadata>>();
  const invalidationVersions = new WeakMap<RpcSession, number>();
  const inFlight = new WeakMap<RpcSession, Map<string, Set<{ valid: boolean }>>>();
  const retainedThreads = new Map<
    string,
    { readers: number; sessions: WeakMap<RpcSession, RetainedMetadata> }
  >();
  const threadKey = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);
  const retainThreadFamily = Atom.family((key: string) =>
    Atom.make((get) => {
      let retained = retainedThreads.get(key);
      if (!retained) {
        retained = { readers: 0, sessions: new WeakMap() };
        retainedThreads.set(key, retained);
      }
      retained.readers++;
      get.addFinalizer(() => {
        if (--retained.readers === 0) retainedThreads.delete(key);
      });
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`file-metadata-thread:${key}`)),
  );
  const revisions = Atom.family((key: string) =>
    Atom.make(0).pipe(Atom.withLabel(`file-metadata-revision:${key}`)),
  );
  const revision = (environmentId: EnvironmentId, path: string) =>
    revisions(JSON.stringify([environmentId, normalizeProjectPathForComparison(path)]));
  const knownEntry = (session: RpcSession, path: string, now: number) => {
    const key = normalizeProjectPathForComparison(path);
    const cached = cache.get(session)?.get(key);
    return cached && cached.expires > now ? cached : undefined;
  };
  const remember = (
    session: RpcSession,
    path: string,
    value: FilesystemEntryMetadata | null,
    now: number,
    partial = false,
  ) => {
    let entries = cache.get(session);
    if (!entries) {
      entries = new Map();
      cache.set(session, entries);
    }
    const key = normalizeProjectPathForComparison(path);
    entries.delete(key);
    const entry = { value, expires: now + METADATA_STALE_TIME_MS };
    entries.set(key, entry);
    for (const thread of retainedThreads.values()) {
      const retained = thread.sessions.get(session);
      const previous = retained?.get(key);
      if (retained && previous)
        retained.set(key, {
          ...entry,
          value:
            partial && value && previous.value?.kind === value.kind
              ? { ...previous.value, ...value }
              : value,
        });
    }
    if (entries.size > METADATA_CACHE_LIMIT) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  };
  const resolver = RequestResolver.makeWith<FileMetadataRequest>({
    batchKey: (entry) => entry.request.session,
    delay: Effect.yieldNow,
    collectWhile: (entries) => entries.size < FILESYSTEM_METADATA_BATCH_LIMIT,
    runAll: Effect.fnUntraced(function* (entries) {
      const session = entries[0].request.session;
      let pending = [...entries];
      while (pending.length > 0) {
        const paths = [...new Set(pending.map((entry) => entry.request.path))];
        let requests = inFlight.get(session);
        if (!requests) {
          requests = new Map();
          inFlight.set(session, requests);
        }
        const tokens = new Map(paths.map((path) => [path, { valid: true }]));
        for (const [path, token] of tokens) {
          let active = requests.get(path);
          if (!active) requests.set(path, (active = new Set()));
          active.add(token);
        }
        const activeRequests = requests;
        pending = yield* Effect.gen(function* () {
          const result = yield* request(WS_METHODS.filesystemGetMetadata, { paths }).pipe(
            Effect.provideService(
              EnvironmentSupervisor.EnvironmentSupervisor,
              entries[0].request.supervisor,
            ),
          );
          const now = yield* Clock.currentTimeMillis;
          const byPath = new Map(paths.map((path, index) => [path, result.entries[index] ?? null]));
          const retry: typeof pending = [];
          for (const entry of pending) {
            // Retry only paths invalidated during this request. Never retain the
            // old response or complete a waiting chip with pre-write metadata.
            if (!tokens.get(entry.request.path)!.valid) {
              retry.push(entry);
              continue;
            }
            const value = byPath.get(entry.request.path) ?? null;
            remember(session, entry.request.path, value, now);
            entry.request.retained?.set(entry.request.path, {
              value,
              expires: now + METADATA_STALE_TIME_MS,
            });
            entry.completeUnsafe(Exit.succeed(value));
          }
          return retry;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const [path, token] of tokens) {
                const active = activeRequests.get(path);
                active?.delete(token);
                if (active?.size === 0) activeRequests.delete(path);
              }
            }),
          ),
        );
      }
    }),
  });

  const metadataFamily = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:filesystem:metadata",
    staleTimeMs: METADATA_STALE_TIME_MS,
    idleTtlMs: METADATA_STALE_TIME_MS,
    execute: Effect.fnUntraced(function* (input: FileMetadataInput) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const session = yield* SubscriptionRef.get(supervisor.session);
      if (session._tag === "None") return null;
      const thread = input.threadId
        ? retainedThreads.get(
            threadKey({ environmentId: supervisor.target.environmentId, threadId: input.threadId }),
          )
        : undefined;
      let retained = thread?.sessions.get(session.value);
      if (thread && !retained) {
        retained = new Map();
        thread.sessions.set(session.value, retained);
      }
      const retainedEntry = retained?.get(input.path);
      if (retainedEntry) return retainedEntry.value;
      const now = yield* Clock.currentTimeMillis;
      const cached = knownEntry(session.value, input.path, now);
      if (cached) {
        retained?.set(input.path, cached);
        return cached.value;
      }
      return yield* Effect.request(
        new FileMetadataRequest({
          path: input.path,
          session: session.value,
          supervisor,
          ...(retained ? { retained } : {}),
        }),
        resolver,
      );
    }),
    refreshTrigger: ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: FileMetadataInput;
    }) => revision(environmentId, input.path),
  });
  const metadata = (target: {
    environmentId: EnvironmentId;
    input: { path: string; threadId?: ThreadId };
  }) =>
    metadataFamily({
      ...target,
      input: { ...target.input, path: normalizeProjectPathForComparison(target.input.path) },
    });

  const rememberEntries = Effect.fnUntraced(function* (
    cwd: string,
    entries: ReadonlyArray<ProjectEntry>,
    isCurrent?: (session: RpcSession) => boolean,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (session._tag === "None") return;
    const now = yield* Clock.currentTimeMillis;
    if (isCurrent && !isCurrent(session.value)) return;
    for (const entry of entries) {
      const path = resolveWorkspaceFilePath(entry.path, cwd);
      const previous = knownEntry(session.value, path, now);
      if (previous?.value?.kind === entry.kind) continue;
      // Listing kinds avoid another request; size and MIME hints are optional.
      remember(session.value, path, { kind: entry.kind }, now, true);
    }
  });

  const invalidate = Effect.fnUntraced(function* (path: string) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (session._tag === "Some") {
      invalidationVersions.set(session.value, (invalidationVersions.get(session.value) ?? 0) + 1);
      const key = normalizeProjectPathForComparison(path);
      for (const token of inFlight.get(session.value)?.get(key) ?? []) token.valid = false;
      cache.get(session.value)?.delete(key);
      for (const thread of retainedThreads.values())
        thread.sessions.get(session.value)?.delete(normalizeProjectPathForComparison(path));
    }
  });

  const rememberFile = Effect.fnUntraced(function* (
    cwd: string,
    file: { relativePath: string; byteLength: number },
    isCurrent?: (session: RpcSession) => boolean,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (session._tag === "None") return;
    const path = resolveWorkspaceFilePath(file.relativePath, cwd);
    const now = yield* Clock.currentTimeMillis;
    if (isCurrent && !isCurrent(session.value)) return;
    const previous = knownEntry(session.value, path, now)?.value;
    remember(
      session.value,
      path,
      {
        ...previous,
        kind: "file",
        byteLength: file.byteLength,
      },
      now,
      true,
    );
  });

  const seedAfterRead = <A, ReadError, ReadServices>(
    read: Effect.Effect<A, ReadError, ReadServices>,
    seed: (
      result: A,
      isCurrent: (session: RpcSession) => boolean,
    ) => Effect.Effect<void, never, EnvironmentSupervisor.EnvironmentSupervisor>,
  ) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const session = yield* SubscriptionRef.get(supervisor.session);
      const version = session._tag === "Some" ? (invalidationVersions.get(session.value) ?? 0) : 0;
      const result = yield* read;
      // Seeding is optional. Any intervening invalidation or reconnect makes
      // the old response unsuitable for the current metadata cache.
      yield* seed(
        result,
        (current) =>
          session._tag === "Some" &&
          current === session.value &&
          (invalidationVersions.get(current) ?? 0) === version,
      );
      return result;
    });

  const refreshPath = (
    environmentId: EnvironmentId,
    path: string,
    registry: AtomRegistry.AtomRegistry,
  ) => {
    const signal = revision(environmentId, path);
    registry.set(signal, registry.get(signal) + 1);
  };

  return {
    metadata,
    retainThread: (ref: ScopedThreadRef) => retainThreadFamily(threadKey(ref)),
    rememberEntries,
    rememberFile,
    seedAfterRead,
    invalidate,
    refreshPath,
  };
}
