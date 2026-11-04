import { makeMethods } from "@effect/vitest";
import { expect, it as browserIt, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { Persistence } from "@t3tools/client-runtime/platform";
import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectionStorage from "./storage";

const it = makeMethods(browserIt);

it.effect("bounds saved query responses per environment across concurrent writers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* EnvironmentQueryStore;
      if (store === null) throw new Error("Expected web query storage");
      const cache = yield* Persistence.EnvironmentCacheStore;
      const environment = EnvironmentId.make("query-cache-count-test");
      const other = EnvironmentId.make("query-cache-other-test");
      yield* cache.clear(environment);
      yield* cache.clear(other);
      yield* Effect.addFinalizer(() =>
        Effect.all([cache.clear(environment), cache.clear(other)], { discard: true }).pipe(
          Effect.orDie,
        ),
      );
      yield* store.save(other, "keep", "other environment");
      yield* store.save(environment, "oldest", "obsolete");
      yield* Effect.forEach(
        Array.from({ length: 256 }, (_, index) => index),
        (index) => store.save(environment, `page-${index}`, `response-${index}`),
        { concurrency: 8 },
      );
      expect(yield* store.load(environment, "oldest")).toEqual(Option.none());
      expect(yield* store.load(environment, "page-255")).toEqual(Option.some("response-255"));
      expect(yield* store.load(other, "keep")).toEqual(Option.some("other environment"));
      const retained = yield* Effect.forEach(
        Array.from({ length: 256 }, (_, index) => index),
        (index) => store.load(environment, `page-${index}`),
      );
      expect(retained.filter(Option.isSome)).toHaveLength(256);
      yield* TestClock.setTime(1);
      yield* store.save(environment, "page-0", "refreshed response");
      yield* TestClock.setTime(2);
      yield* store.save(environment, "extra", "extra response");
      expect(yield* store.load(environment, "page-0")).toEqual(Option.some("refreshed response"));
      expect(yield* store.load(environment, "page-1")).toEqual(Option.none());
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  ),
);

it.effect("limits retained query payloads to 32 MiB of UTF-8 bytes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* EnvironmentQueryStore;
      if (store === null) throw new Error("Expected web query storage");
      const cache = yield* Persistence.EnvironmentCacheStore;
      const environment = EnvironmentId.make("query-cache-bytes-test");
      yield* cache.clear(environment);
      yield* Effect.addFinalizer(() => cache.clear(environment).pipe(Effect.orDie));
      const payload = "🐎".repeat(1024 * 1024);
      for (let index = 0; index < 9; index++)
        yield* store.save(environment, `page-${index}`, payload);
      expect(Option.isNone(yield* store.load(environment, "page-0"))).toBe(true);
      for (let index = 1; index < 9; index++) {
        expect(Option.isSome(yield* store.load(environment, `page-${index}`))).toBe(true);
      }
      yield* store.save(environment, "oversized", payload + "x");
      expect(Option.isNone(yield* store.load(environment, "oversized"))).toBe(true);
      yield* store.save(environment, "page-8", payload + "x");
      const kept = yield* store.load(environment, "page-8");
      expect(Option.isSome(kept) && kept.value === payload).toBe(true);
      expect(Option.isSome(yield* store.load(environment, "page-1"))).toBe(true);
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  ),
);

it.effect("expires old responses without expiring a refreshed key", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-01T00:00:00Z"));
      const store = yield* EnvironmentQueryStore;
      if (store === null) throw new Error("Expected web query storage");
      const cache = yield* Persistence.EnvironmentCacheStore;
      const environment = EnvironmentId.make("query-cache-age-test");
      yield* cache.clear(environment);
      yield* Effect.addFinalizer(() => cache.clear(environment).pipe(Effect.orDie));
      yield* store.save(environment, "old", "old response");
      yield* store.save(environment, "refreshed", "previous response");
      yield* TestClock.setTime(Date.parse("2026-01-30T00:00:00Z"));
      expect(yield* store.load(environment, "old")).toEqual(Option.some("old response"));
      yield* store.save(environment, "refreshed", "current response");
      yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"));
      expect(yield* store.load(environment, "old")).toEqual(Option.none());
      expect(yield* store.load(environment, "refreshed")).toEqual(Option.some("current response"));
    }).pipe(Effect.provide(ConnectionStorage.layer)),
  ),
);

it.effect("upgrades legacy query strings without losing the connection catalog", () =>
  Effect.gen(function* () {
    const name = "query-cache-upgrade-test";
    const open = indexedDB.open.bind(indexedDB);
    using _database = vi
      .spyOn(indexedDB, "open")
      .mockImplementation((_name, version) => open(name, version));
    const target = {
      _tag: "BearerConnectionTarget",
      environmentId: "upgrade-environment",
      label: "Keep this connection",
      connectionId: "upgrade-connection",
    };
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = open(name, 5);
          request.onupgradeneeded = () => {
            request.result
              .createObjectStore("environment-query")
              .put("legacy payload", "upgrade-environment:old");
            request.result.createObjectStore("catalog").put(
              JSON.stringify({
                schemaVersion: 1,
                targets: [target],
                profiles: [],
                credentials: [],
                remoteDpopTokens: [],
                disabledEnvironmentIds: [],
              }),
              "document",
            );
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        }),
    );
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* EnvironmentQueryStore;
          if (store === null) throw new Error("Expected web query storage");
          const targets = yield* Persistence.ConnectionTargetStore;
          expect(yield* targets.list).toEqual([target]);
          const environment = EnvironmentId.make("upgrade-environment");
          expect(yield* store.load(environment, "old")).toEqual(Option.none());
          yield* store.save(environment, "new", "new payload");
          expect(yield* store.load(environment, "new")).toEqual(Option.some("new payload"));
        }).pipe(Effect.provide(ConnectionStorage.layer)),
      );
    } finally {
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          }),
      );
    }
  }),
);
