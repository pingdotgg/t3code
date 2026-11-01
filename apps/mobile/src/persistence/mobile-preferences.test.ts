import { describe, expect, it } from "@effect/vitest";
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
  let pendingSave:
    | { started: PromiseWithResolvers<void>; finish: PromiseWithResolvers<void> }
    | undefined;
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
      Effect.promise(async () => {
        const pending = pendingSave;
        pendingSave = undefined;
        if (pending) {
          pending.started.resolve();
          await pending.finish.promise;
        }
        stored = Option.some({ payload, updatedAt });
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
    delayNextSave: () => {
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      pendingSave = { started, finish };
      return { started: Effect.promise(() => started.promise), finish: () => finish.resolve() };
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

  it.effect.each(["update", "fallback", "legacy"] as const)(
    "waits for an interrupted %s write before the next update",
    (path) => {
      const storage = makeStorage();
      return Effect.gen(function* () {
        const store = yield* MobilePreferences.MobilePreferencesStore;
        const preferences = { planModeEnabled: true, workingShelfEnabled: true };
        if (path === "update") {
          yield* store.savePatch({ planModeEnabled: true });
        } else if (path === "fallback") {
          storage.secure.set(
            FALLBACK_KEY,
            JSON.stringify({ payload: JSON.stringify(preferences), updatedAt: 100 }),
          );
        } else {
          storage.secure.set("t3code.preferences", JSON.stringify(preferences));
        }

        const pending = storage.delayNextSave();
        const order: string[] = [];
        const write: Effect.Effect<
          MobilePreferences.Preferences,
          | MobilePreferences.MobilePreferencesSaveError
          | MobilePreferences.MobilePreferencesLoadError
        > = path === "update" ? store.savePatch({ workingShelfEnabled: true }) : store.load;
        const interrupted = yield* Effect.forkChild(
          write.pipe(Effect.onExit(() => Effect.sync(() => void order.push("write exited")))),
        );
        yield* pending.started;
        const interruption = yield* Effect.forkChild(Fiber.interrupt(interrupted), {
          startImmediately: true,
        });
        const next = yield* Effect.forkChild(
          store
            .savePatch({ codeWordBreak: true })
            .pipe(Effect.onExit(() => Effect.sync(() => void order.push("next exited")))),
          { startImmediately: true },
        );
        order.push("native write released");
        pending.finish();
        yield* Fiber.join(interruption);
        yield* Fiber.join(next);
        yield* store.savePatch({ collapsedProjectGroups: ["a"] });

        expect(storage.stored()).toEqual(
          Option.some({ ...preferences, codeWordBreak: true, collapsedProjectGroups: ["a"] }),
        );
        expect(order).toEqual(["native write released", "write exited", "next exited"]);
      }).pipe(Effect.provide(storage.layer));
    },
  );

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
