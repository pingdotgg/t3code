import {
  FILESYSTEM_METADATA_BATCH_LIMIT,
  type EnvironmentId,
  type FilesystemEntryMetadata,
  type ProjectEntry,
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
import { Atom } from "effect/reactivity";

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

class FileMetadataRequest extends Request.Class<
  {
    path: string;
    session: RpcSession;
    supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  },
  FilesystemEntryMetadata | null,
  EnvironmentRpcFailure<typeof WS_METHODS.filesystemGetMetadata> | EnvironmentRpcUnavailableError
> {}

/** Shared by file chips, search results, and the file tree in one client. Cache
 * entries belong to an RPC session so reconnects and grant changes recheck them. */
export function createFileMetadataAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const cache = new WeakMap<
    RpcSession,
    Map<string, { value: FilesystemEntryMetadata | null; expires: number }>
  >();
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
    entries.set(key, { value, expires: now + METADATA_STALE_TIME_MS });
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
        entry.completeUnsafe(Exit.succeed(value));
      }
    }),
  });

  const metadataFamily = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:filesystem:metadata",
    staleTimeMs: METADATA_STALE_TIME_MS,
    idleTtlMs: METADATA_STALE_TIME_MS,
    execute: Effect.fnUntraced(function* (input: { path: string }) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const session = yield* SubscriptionRef.get(supervisor.session);
      if (session._tag === "None") return null;
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(session.value)?.get(normalizeProjectPathForComparison(input.path));
      if (cached && cached.expires > now) return cached.value;
      return yield* Effect.request(
        new FileMetadataRequest({ path: input.path, session: session.value, supervisor }),
        resolver,
      );
    }),
  });
  const metadata = (target: { environmentId: EnvironmentId; input: { path: string } }) =>
    metadataFamily({
      ...target,
      input: { path: normalizeProjectPathForComparison(target.input.path) },
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
      const previous = cache.get(session.value)?.get(normalizeProjectPathForComparison(path));
      if (previous && previous.expires > now && previous.value?.kind === entry.kind) continue;
      remember(session.value, path, { kind: entry.kind }, now);
    }
  });

  const invalidate = Effect.fnUntraced(function* (path: string) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (session._tag === "Some")
      cache.get(session.value)?.delete(normalizeProjectPathForComparison(path));
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
    const cached = cache.get(session.value)?.get(normalizeProjectPathForComparison(path));
    const previous = cached && cached.expires > now ? cached.value : null;
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

  return { metadata, rememberEntries, rememberFile, invalidate };
}
