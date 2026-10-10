import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";
vi.mock("expo-secure-store", () => ({}));
import { MobileDatabase } from "./mobile-database";
import { MobileSecureStorage } from "./mobile-secure-storage";
import { make } from "./mobile-preferences";

it.effect("drops an unknown stored language without resetting unrelated mobile preferences", () =>
  Effect.gen(function* () {
    let saved = JSON.stringify({ languagePreference: "ja", baseFontSize: 19, themeMode: "dark" });
    const unused = () => Effect.die("Unexpected cache operation");
    const database = MobileDatabase.of({
      loadCache: unused,
      listCache: unused,
      saveCache: unused,
      removeCache: unused,
      clearCacheKind: unused,
      clearEnvironmentCache: unused,
      clearAllCaches: unused(),
      inspectCaches: unused(),
      loadPreferencesJson: Effect.sync(() => Option.some({ payload: saved, updatedAt: 1 })),
      savePreferencesJson: (payload) =>
        Effect.sync(() => {
          saved = payload;
        }),
    });
    const secureStorage = MobileSecureStorage.of({
      getItem: () => Effect.succeed(null),
      setItem: () => Effect.die("Unexpected secure storage write"),
      removeItem: () => Effect.void,
    });
    const store = yield* make().pipe(
      Effect.provideService(MobileDatabase, database),
      Effect.provideService(MobileSecureStorage, secureStorage),
    );
    expect(yield* store.load).toEqual({ baseFontSize: 19, themeMode: "dark" });
    yield* store.savePatch({ languagePreference: "zh" });
    expect(yield* store.load).toEqual({
      languagePreference: "zh",
      baseFontSize: 19,
      themeMode: "dark",
    });
  }),
);
