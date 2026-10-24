import {
  ConnectionTransientError,
  BearerConnectionCredential,
  CredentialStore,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ConnectionCatalogDocument, Persistence } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

import * as ConnectionStorage from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectionStorage.makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
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
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("platform bearer conditional eviction", () => {
  it.effect("checks the credential under the catalog lock after a queued replacement commits", () =>
    Effect.gen(function* () {
      let replacing!: () => void;
      const replacingPromise = new Promise<void>((resolve) => {
        replacing = resolve;
      });
      let release!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const old = new BearerConnectionCredential({ token: "old" });
      const fresh = new BearerConnectionCredential({ token: "replacement" });
      let raw: string | null = null;
      let writes = 0;
      vi.stubGlobal(
        "window",
        Object.assign(new EventTarget(), {
          desktopBridge: {
            getConnectionCatalog: async () => raw,
            setConnectionCatalog: async (next: string) => {
              if (++writes === 2) {
                replacing();
                await releasePromise;
              }
              raw = next;
              return true;
            },
          },
        }),
      );
      yield* Effect.gen(function* () {
        const store = yield* CredentialStore.ConnectionCredentialStore;
        yield* store.put("backend", old);
        const observed = Option.getOrThrow(yield* store.get("backend"));
        const replacement = yield* store
          .put("backend", fresh)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => replacingPromise);
        const removal = yield* store.removeIfMatches!("backend", observed).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        release();
        yield* Fiber.join(replacement);
        yield* Fiber.join(removal);
        expect(yield* store.get("backend")).toEqual(Option.some(fresh));
        expect(yield* store.wasRejected!("backend", old)).toBe(false);
        yield* store.removeIfMatches!("backend", fresh);
        expect(yield* store.get("backend")).toEqual(Option.none());
        expect(yield* store.wasRejected!("backend", fresh)).toBe(true);
        yield* store.put("backend", fresh);
        expect(yield* store.wasRejected!("backend", fresh)).toBe(true);
        yield* store.removeIfMatches!("backend", fresh);
        expect(decodeCatalog(raw!).credentials).toEqual([]);
      }).pipe(Effect.provide(ConnectionStorage.layer), Effect.scoped);
    }),
  );
});

const fixedHandle = (database: IDBDatabase) => ({
  get: Effect.succeed(database),
  invalidate: () => Effect.void,
});

describe("ConnectionStorage.makeCatalogBackend", () => {
  it.effect("fails IndexedDB writes whose commit aborts", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event("abort"));
            });
          },
        }),
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => transaction } as unknown as IDBDatabase),
      );

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error.message).toContain("QuotaExceededError");
    }),
  );
});

describe("IndexedDB connection recovery", () => {
  it.effect("reopens after a forced close and finalizes the current connection", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const makeDatabase = () =>
        Object.assign(new EventTarget(), {
          close: vi.fn(),
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const request = Object.assign(new EventTarget(), {
                  result: undefined,
                  error: null,
                });
                queueMicrotask(() => request.dispatchEvent(new Event("success")));
                return request;
              },
            }),
          }),
        }) as unknown as IDBDatabase;
      const first = makeDatabase();
      const second = makeDatabase();
      const databases = [first, second];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const environmentId = EnvironmentId.make("env");
        const threadId = ThreadId.make("thread");
        expect(Option.isNone(yield* cache.loadThread(environmentId, threadId))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);

        first.dispatchEvent(new Event("close"));
        const recovered = yield* Effect.all(
          [cache.loadThread(environmentId, threadId), cache.loadThread(environmentId, threadId)],
          { concurrency: 2 },
        );
        expect(recovered.every(Option.isNone)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection closed without a close event", () => {
  it.effect("reopens and retries the failing operation once", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const closing = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => {
          // Chromium force-closed this connection; this tab never saw "close".
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      }) as unknown as IDBDatabase;
      const fresh = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const request = Object.assign(new EventTarget(), { result: undefined, error: null });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
          }),
        }),
      }) as unknown as IDBDatabase;
      const databases = [closing, fresh];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const loaded = yield* cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread"));
        expect(Option.isNone(loaded)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser);
      const second = ConnectionStorage.makeBrowserGitHubRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      const staleCatalog = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.void,
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(
        yield* ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser).get(entry),
      ).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }).pipe(Effect.scoped),
  );
});
