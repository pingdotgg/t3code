import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

const FALLBACK_KEY = "t3code.preferences.fallback";

function makeStorage() {
  let databaseLoads = 0;
  let failDatabaseLoad = false;
  let afterDatabaseSave: Effect.Effect<void> = Effect.void;
  let stored: Option.Option<MobileDatabase.StoredPreferencesJson> = Option.none();
  const secure = new Map<string, string>();

  const database = MobileDatabase.MobileDatabase.of({
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.suspend(() => {
      databaseLoads++;
      return failDatabaseLoad
        ? Effect.fail(
            new MobileDatabase.MobileDatabaseError({ operation: "load-preferences", cause: null }),
          )
        : Effect.succeed(stored);
    }),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.suspend(() => {
        stored = Option.some({ payload, updatedAt });
        return afterDatabaseSave;
      }),
  });
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => secure.get(key) ?? null),
    setItem: (key, value) => Effect.sync(() => void secure.set(key, value)),
    removeItem: (key) => Effect.sync(() => void secure.delete(key)),
  });

  const layer = MobilePreferences.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(MobileDatabase.MobileDatabase, database),
        Layer.succeed(MobileSecureStorage.MobileSecureStorage, secureStorage),
      ),
    ),
  );
  return {
    secure,
    layer,
    databaseLoads: () => databaseLoads,
    failDatabaseLoad: (fail: boolean) => {
      failDatabaseLoad = fail;
    },
    afterDatabaseSave: (effect: Effect.Effect<void>) => {
      afterDatabaseSave = effect;
    },
    stored: () => Option.map(stored, ({ payload }) => JSON.parse(payload) as unknown),
    setStored: (preferences: MobilePreferences.Preferences, updatedAt: number) => {
      stored = Option.some({ payload: JSON.stringify(preferences), updatedAt });
    },
  };
}

describe("MobilePreferencesStore", () => {
  it.effect("reads storage once across serialized updates", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      yield* Effect.all(
        [
          store.savePatch({ planModeEnabled: true }),
          store.update((current) => ({
            collapsedProjectGroups: [...(current.collapsedProjectGroups ?? []), "a"],
          })),
          store.update((current) => ({
            collapsedProjectGroups: [...(current.collapsedProjectGroups ?? []), "b"],
          })),
        ],
        { concurrency: "unbounded" },
      );

      expect(storage.stored()).toEqual(
        Option.some({ planModeEnabled: true, collapsedProjectGroups: ["a", "b"] }),
      );
      expect(storage.databaseLoads()).toBe(1);
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("rereads storage after an update is interrupted mid-save", () => {
    const storage = makeStorage();
    return Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      yield* store.savePatch({ planModeEnabled: true });

      const saved = yield* Deferred.make<void>();
      storage.afterDatabaseSave(
        Deferred.succeed(saved, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const interrupted = yield* Effect.forkChild(store.savePatch({ workingShelfEnabled: true }));
      yield* Deferred.await(saved);
      yield* Fiber.interrupt(interrupted);

      storage.afterDatabaseSave(Effect.void);
      yield* store.savePatch({ codeWordBreak: true });
      expect(storage.stored()).toEqual(
        Option.some({ planModeEnabled: true, workingShelfEnabled: true, codeWordBreak: true }),
      );
    }).pipe(Effect.provide(storage.layer));
  });

  it.effect("does not reuse a load that could not read the database", () => {
    const storage = makeStorage();
    storage.setStored({ planModeEnabled: true }, 100);
    storage.secure.set(
      FALLBACK_KEY,
      JSON.stringify({ payload: JSON.stringify({ planModeEnabled: false }), updatedAt: 50 }),
    );
    return Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      storage.failDatabaseLoad(true);
      expect(yield* store.load).toEqual({ planModeEnabled: false });

      storage.failDatabaseLoad(false);
      yield* store.savePatch({ codeWordBreak: true });
      expect(storage.stored()).toEqual(Option.some({ planModeEnabled: true, codeWordBreak: true }));
    }).pipe(Effect.provide(storage.layer));
  });
});
