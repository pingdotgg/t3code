import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  ConnectionPersistenceError,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { connectionStorageLayer, makeCatalogBackend, makeCatalogStore } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadSnapshot: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 7,
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Cached thread",
    modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-spark-1.3" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    pullRequests: [],
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  },
};

function stubThreadCacheDatabase(schemaVersion: number) {
  const rows = new Map<string, unknown>([
    [
      `${environmentId}:${threadId}`,
      JSON.stringify({ schemaVersion, environmentId, threadId, snapshot: threadSnapshot }),
    ],
  ]);
  const onSuccess = (type: string, callback: () => void) => {
    if (type === "success") queueMicrotask(callback);
  };
  const database = {
    close: vi.fn(),
    transaction: () => ({
      addEventListener: (type: string, callback: () => void) => {
        if (type === "complete") queueMicrotask(callback);
      },
      objectStore: () => ({
        get: (key: string) => ({ result: rows.get(key), addEventListener: onSuccess }),
        put: (value: unknown, key: string) => rows.set(key, value),
      }),
    }),
  };
  vi.stubGlobal("window", {});
  vi.stubGlobal("indexedDB", {
    open: () => ({ result: database, addEventListener: onSuccess }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

describe("thread snapshot cache", () => {
  it.effect("rejects v3 snapshots whose historical activities need to be refetched", () => {
    stubThreadCacheDatabase(3);
    return Effect.gen(function* () {
      const cache = yield* EnvironmentCacheStore;
      const error = yield* cache.loadThread(environmentId, threadId).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionPersistenceError);
      expect(error.operation).toBe("load-thread");
    }).pipe(Effect.provide(connectionStorageLayer));
  });

  it.effect(
    "accepts v4 snapshots and roundtrips replacement snapshots in the current format",
    () => {
      stubThreadCacheDatabase(4);
      return Effect.gen(function* () {
        const cache = yield* EnvironmentCacheStore;
        expect(yield* cache.loadThread(environmentId, threadId)).toEqual(
          Option.some(threadSnapshot),
        );

        const refreshed = {
          ...threadSnapshot,
          snapshotSequence: 8,
          thread: { ...threadSnapshot.thread, title: "Refreshed thread" },
        };
        yield* cache.saveThread(environmentId, refreshed);

        expect(yield* cache.loadThread(environmentId, threadId)).toEqual(Option.some(refreshed));
      }).pipe(Effect.provide(connectionStorageLayer));
    },
  );
});
