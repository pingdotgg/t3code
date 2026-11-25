import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-sqlite", () => ({ openDatabaseAsync: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

function storeWith(initialPayload: string | null) {
  let stored: MobileDatabase.StoredPreferencesJson | null =
    initialPayload === null ? null : { payload: initialPayload, updatedAt: 1 };
  const database = {
    loadPreferencesJson: Effect.sync(() => Option.fromNullishOr(stored)),
    savePreferencesJson: (payload: string, updatedAt: number) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  } as Partial<
    MobileDatabase.MobileDatabase["Service"]
  > as MobileDatabase.MobileDatabase["Service"];
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return MobilePreferences.layer.pipe(
    Layer.provide(Layer.succeed(MobileDatabase.MobileDatabase, database)),
    Layer.provide(Layer.succeed(MobileSecureStorage.MobileSecureStorage, secureStorage)),
  );
}

describe("MobilePreferencesStore", () => {
  it.effect("loads defaults when nothing is stored", () =>
    Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      expect(yield* store.load).toEqual({});
    }).pipe(Effect.provide(storeWith(null))),
  );

  it.effect("fails the load when stored preferences cannot be read", () =>
    Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      const loaded = yield* Effect.exit(store.load);
      expect(Exit.isFailure(loaded)).toBe(true);
    }).pipe(Effect.provide(storeWith("{not json"))),
  );

  it.effect("a save replaces unreadable preferences", () =>
    Effect.gen(function* () {
      const store = yield* MobilePreferences.MobilePreferencesStore;
      yield* store.savePatch({ appLockEnabled: true });
      expect(yield* store.load).toEqual({ appLockEnabled: true });
    }).pipe(Effect.provide(storeWith("{not json"))),
  );
});
