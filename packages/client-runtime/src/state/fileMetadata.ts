import {
  FILESYSTEM_METADATA_BATCH_LIMIT,
  type EnvironmentId,
  type FilesystemEntryMetadata,
  type ProjectEntry,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
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
    for (const thread of retainedThreads.values()) {
      const retained = thread.sessions.get(session)?.get(key);
      if (retained) return retained;
    }
    const cached = cache.get(session)?.get(key);
    return cached && cached.expires > now ? cached : undefined;
  };
  const remember = (
    session: RpcSession,
    path: string,
    value: FilesystemEntryMetadata | null,
    now: number,
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
      if (retained?.has(key)) retained.set(key, entry);
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
      const paths = [...new Set(entries.map((entry) => entry.request.path))];
      const result = yield* request(WS_METHODS.filesystemGetMetadata, { paths }).pipe(
        Effect.provideService(
          EnvironmentSupervisor.EnvironmentSupervisor,
          entries[0].request.supervisor,
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const byPath = new Map(paths.map((path, index) => [path, result.entries[index] ?? null]));
      for (const entry of entries) {
        const value = byPath.get(entry.request.path) ?? null;
        remember(entry.request.session, entry.request.path, value, now);
        entry.request.retained?.set(entry.request.path, {
          value,
          expires: now + METADATA_STALE_TIME_MS,
        });
        entry.completeUnsafe(Exit.succeed(value));
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
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (session._tag === "None") return;
    const now = yield* Clock.currentTimeMillis;
    for (const entry of entries) {
      const path = splitFilePathPosition(resolvePathLinkTarget(entry.path, cwd)).path;
      const previous = knownEntry(session.value, path, now);
      if (previous?.value?.kind === entry.kind) continue;
      remember(session.value, path, { kind: entry.kind }, now);
    }
  });

  const invalidate = Effect.fnUntraced(function* (path: string) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (session._tag === "Some") {
      cache.get(session.value)?.delete(normalizeProjectPathForComparison(path));
      for (const thread of retainedThreads.values())
        thread.sessions.get(session.value)?.delete(normalizeProjectPathForComparison(path));
    }
  });

  const rememberFile = Effect.fnUntraced(function* (
    cwd: string,
    file: { relativePath: string; byteLength: number },
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (session._tag === "None") return;
    const path = splitFilePathPosition(resolvePathLinkTarget(file.relativePath, cwd)).path;
    const now = yield* Clock.currentTimeMillis;
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
    );
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
    invalidate,
    refreshPath,
  };
}
