import {
  BearerConnectionTarget,
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  ConnectionTransientError,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  ConnectionCatalogDocument,
  Persistence,
  recoverProvisionalPairings,
  registerConnectionInCatalog,
  settleProvisionalPairingInCatalog,
} from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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

const cloneEnvironmentId = EnvironmentId.make("clone");

function cloneRegistration(
  connectionId: string,
  label: string,
  provisionalPairingId?: string,
  environmentId = cloneEnvironmentId,
) {
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId,
      connectionId,
      label,
      ...(provisionalPairingId === undefined ? {} : { provisionalPairingId }),
    }),
    profile: new BearerConnectionProfile({
      environmentId,
      connectionId,
      label,
      httpBaseUrl: "https://clone.example.test",
      wsBaseUrl: "wss://clone.example.test",
    }),
    credential: new BearerConnectionCredential({ token: label }),
  });
}

function desktopCatalog(raw: string) {
  const bridge = {
    windowContext: { additional: false, workspace: null },
    getConnectionCatalog: vi.fn(async () => raw),
    setConnectionCatalog: vi.fn(async (next: string) => {
      raw = next;
      return true;
    }),
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { desktopBridge: bridge }));
  let tail = Promise.resolve<unknown>(undefined);
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, _options: unknown, write: () => Promise<unknown>) => {
        const next = tail.then(write);
        tail = next.catch(() => undefined);
        return next;
      },
    },
  });
  return { bridge, read: () => decodeCatalog(raw) };
}

describe("desktop connection catalog recovery", () => {
  it.effect.each(["bearer:clone:https://clone.example.test", "bearer:orbit-reservation:install"])(
    "preserves another window’s replacement %s across a stale label write and cleanup retry",
    (replacementId) =>
      Effect.gen(function* () {
        const desktop = desktopCatalog(encodeCatalog(emptyCatalog));
        const main = yield* Layer.build(ConnectionStorage.layer);
        desktop.bridge.windowContext.additional = true;
        const extra = yield* Layer.build(ConnectionStorage.layer);
        const oldStore = Context.get(main, Persistence.ConnectionRegistrationStore);
        const newStore = Context.get(extra, Persistence.ConnectionRegistrationStore);
        const pending = cloneRegistration("bearer:orbit-reservation:install", "Prewarm", "install");
        const replacement = cloneRegistration(replacementId, "Independent");
        yield* oldStore.register(pending, [pending.target]);
        desktop.bridge.setConnectionCatalog.mockResolvedValueOnce(false);
        yield* oldStore
          .settleProvisionalPairing(cloneEnvironmentId, "install", false)
          .pipe(Effect.flip);
        yield* newStore.register(replacement, [replacement.target]);

        expect(
          yield* oldStore.learnLabel(cloneEnvironmentId, [pending.target], "New server label"),
        ).toEqual([]);
        yield* oldStore.settleProvisionalPairing(cloneEnvironmentId, "install", false);

        expect(desktop.read()).toEqual(registerConnectionInCatalog(emptyCatalog, replacement));

        const renamed = new BearerConnectionTarget({
          ...replacement.target,
          label: "Current label",
        });
        expect(
          yield* newStore.learnLabel(cloneEnvironmentId, [replacement.target], renamed.label),
        ).toEqual([renamed]);
        expect(desktop.read()).toEqual({
          ...registerConnectionInCatalog(emptyCatalog, replacement),
          targets: [renamed],
        });
      }),
  );

  it.effect("retries startup recovery when desktop encryption becomes available", () =>
    Effect.gen(function* () {
      const pending = cloneRegistration("bearer:orbit-reservation:install", "Prewarm", "install");
      const catalog = registerConnectionInCatalog(emptyCatalog, pending);
      const desktop = desktopCatalog(encodeCatalog(catalog));
      let available = false;
      const readCatalog = desktop.bridge.getConnectionCatalog.getMockImplementation()!;
      desktop.bridge.getConnectionCatalog.mockImplementation(async () => {
        if (!available) throw new Error("Desktop connection catalog protection failed");
        return readCatalog();
      });
      // The registry reads both lists during layer construction, while recovery is still pending.
      const registryStartup = Layer.effectDiscard(
        Effect.gen(function* () {
          const targets = yield* Persistence.ConnectionTargetStore;
          expect(yield* targets.list).toEqual([]);
          expect(yield* targets.listDisabled).toEqual([]);
        }),
      ).pipe(Layer.provide(ConnectionStorage.layer));
      const startup = yield* Layer.build(registryStartup).pipe(Effect.forkScoped);

      yield* TestClock.adjust("4 seconds");
      expect(desktop.bridge.getConnectionCatalog.mock.calls.length).toBeGreaterThan(1);
      expect(desktop.bridge.setConnectionCatalog).not.toHaveBeenCalled();
      expect(desktop.read()).toEqual(catalog);

      available = true;
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(startup);
      expect(desktop.read()).toEqual(emptyCatalog);
    }),
  );
  it.effect("keeps a new install created while the startup recovery read retries", () =>
    Effect.gen(function* () {
      const abandoned = cloneRegistration("bearer:orbit-reservation:install", "Prewarm", "install");
      const current = cloneRegistration(
        "bearer:orbit-reservation:active",
        "Active",
        "active",
        EnvironmentId.make("new-clone"),
      );
      const desktop = desktopCatalog(
        encodeCatalog(registerConnectionInCatalog(emptyCatalog, abandoned)),
      );
      desktop.bridge.getConnectionCatalog.mockRejectedValueOnce(new Error("Read interrupted"));
      const services = yield* Layer.build(ConnectionStorage.layer);
      const registrations = Context.get(services, Persistence.ConnectionRegistrationStore);
      // The live install itself triggers the first successful catalog load.
      expect(yield* registrations.register(current, [current.target])).toBe(true);
      yield* TestClock.adjust("10 seconds");
      expect(desktop.read()).toEqual(registerConnectionInCatalog(emptyCatalog, current));
    }),
  );
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

  it.effect("replays a failed desktop cleanup against the latest catalog from another window", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("clone");
      const provisional = new BearerConnectionTarget({
        environmentId,
        label: "provisional",
        connectionId: "route",
        provisionalPairingId: "install",
      });
      const replacement = new BearerConnectionTarget({
        environmentId,
        label: "independent",
        connectionId: "route",
      });
      const credential = new BearerConnectionCredential({ token: "stored-session" });
      let raw = encodeCatalog({
        ...emptyCatalog,
        targets: [provisional],
        credentials: [{ connectionId: "route", credential, provisionalPairingId: "install" }],
      });
      let fail = true;
      const backend: ConnectionStorage.CatalogBackend = {
        sharedAcrossWindows: true,
        read: Effect.sync(() => raw),
        write: (next) =>
          Effect.suspend(() =>
            fail
              ? Effect.fail(
                  new ConnectionTransientError({ reason: "remote-unavailable", detail: "disk" }),
                )
              : Effect.sync(() => {
                  raw = next;
                }),
          ),
      };
      const old = yield* ConnectionStorage.makeCatalogStore(backend);
      const restarted = yield* ConnectionStorage.makeCatalogStore(backend);
      expect((yield* restarted.read).targets).toEqual([provisional]);
      yield* old
        .update((doc) => settleProvisionalPairingInCatalog(doc, "install", false))
        .pipe(Effect.flip);
      fail = false;
      const otherWindow = yield* ConnectionStorage.makeCatalogStore(backend);
      // A new route was saved independently. The orphan credential is still tagged by the old write.
      yield* otherWindow.update((doc) => ({ ...doc, targets: [replacement] }));
      yield* recoverProvisionalPairings(restarted);
      expect(decodeCatalog(raw).targets).toEqual([replacement]);
      expect(decodeCatalog(raw).credentials).toEqual([]);
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
      const first = ConnectionStorage.makeBrowserPullRequestRoutingPermissions(firstBrowser);
      const second = ConnectionStorage.makeBrowserPullRequestRoutingPermissions(secondBrowser);
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
        yield* ConnectionStorage.makeBrowserPullRequestRoutingPermissions(firstBrowser).get(entry),
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
    }),
  );
});
