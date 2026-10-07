import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { MobileDatabase, type StoredPreferencesJson } from "./mobile-database";
import { MobileSecureStorage } from "./mobile-secure-storage";
import { make } from "./mobile-preferences";

function fixture(initial: string) {
  let stored: StoredPreferencesJson = { payload: initial, updatedAt: 1 };
  const database = MobileDatabase.of({
    loadPreferencesJson: Effect.sync(() => Option.some(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
  });
  const secure = MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return make().pipe(
    Effect.provideService(MobileDatabase, database),
    Effect.provideService(MobileSecureStorage, secure),
  );
}

describe("mobile interface language persistence", () => {
  it.effect(
    "preserves Chinese on reload and persists switching back without losing appearance",
    () =>
      Effect.gen(function* () {
        const store = yield* fixture('{"interfaceLanguage":"zh-CN","baseFontSize":18}');
        expect(yield* store.load).toEqual({ interfaceLanguage: "zh-CN", baseFontSize: 18 });
        yield* store.savePatch({ interfaceLanguage: "en" });
        expect(yield* store.load).toEqual({ interfaceLanguage: "en", baseFontSize: 18 });
      }),
  );
  it.effect("ignores an unsupported language while retaining valid preferences", () =>
    Effect.gen(function* () {
      const store = yield* fixture('{"interfaceLanguage":"fr","baseFontSize":18}');
      expect(yield* store.load).toEqual({ baseFontSize: 18 });
    }),
  );
  it.effect("loads preferences written before localization was added", () =>
    Effect.gen(function* () {
      const store = yield* fixture('{"baseFontSize":18}');
      expect(yield* store.load).toEqual({ baseFontSize: 18 });
    }),
  );
});
