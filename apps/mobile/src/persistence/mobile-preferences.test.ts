import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { MobileDatabase, type StoredPreferencesJson } from "./mobile-database";
import { make } from "./mobile-preferences";
import { MobileSecureStorage } from "./mobile-secure-storage";

describe("remembered worktree bases", () => {
  it.effect("preserves project selections after reloading preferences and unrelated updates", () =>
    Effect.gen(function* () {
      let stored: StoredPreferencesJson | null = null;
      const database = MobileDatabase.of({
        listCache: () => Effect.succeed([]),
        loadCache: () => Effect.succeed(Option.none()),
        saveCache: () => Effect.void,
        removeCache: () => Effect.void,
        clearCacheKind: () => Effect.void,
        clearEnvironmentCache: () => Effect.void,
        clearAllCaches: Effect.void,
        inspectCaches: Effect.succeed([]),
        loadPreferencesJson: Effect.sync(() => Option.fromNullishOr(stored)),
        savePreferencesJson: (payload, updatedAt) =>
          Effect.sync(() => {
            stored = { payload, updatedAt };
          }),
      });
      const createStore = make().pipe(
        Effect.provideService(MobileDatabase, database),
        Effect.provideService(MobileSecureStorage, {
          getItem: () => Effect.succeed(null),
          setItem: () => Effect.void,
          removeItem: () => Effect.void,
        }),
      );
      const first = yield* createStore;
      yield* first.savePatch({
        lastWorktreeBaseBranchByProject: { "env-a:project-a": "dev", "env-b:project-a": "release" },
      });
      const restarted = yield* createStore;
      yield* restarted.savePatch({ baseFontSize: 18 });
      expect((yield* restarted.load).lastWorktreeBaseBranchByProject).toEqual({
        "env-a:project-a": "dev",
        "env-b:project-a": "release",
      });
    }),
  );
});
