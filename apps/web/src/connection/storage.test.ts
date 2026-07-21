import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { makeCatalogBackend, makeCatalogStore, upgradeConnectionDatabase } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

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

describe("upgradeConnectionDatabase", () => {
  it("clears existing thread snapshots when upgrading to archive-time cache eviction", () => {
    const stores = new Set(["catalog", "shell", "thread", "server-config", "vcs-refs"]);
    const clear = vi.fn();
    const database = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: vi.fn((name: string) => stores.add(name)),
    } as unknown as IDBDatabase;
    const transaction = {
      objectStore: vi.fn(() => ({ clear })),
    } as unknown as IDBTransaction;

    upgradeConnectionDatabase(database, transaction, 4);

    expect(transaction.objectStore).toHaveBeenCalledWith("thread");
    expect(clear).toHaveBeenCalledOnce();
  });

  it("does not clear thread snapshots after the migration has already run", () => {
    const stores = new Set(["catalog", "shell", "thread", "server-config", "vcs-refs"]);
    const clear = vi.fn();
    const database = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: vi.fn((name: string) => stores.add(name)),
    } as unknown as IDBDatabase;
    const transaction = {
      objectStore: vi.fn(() => ({ clear })),
    } as unknown as IDBTransaction;

    upgradeConnectionDatabase(database, transaction, 5);

    expect(transaction.objectStore).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});
