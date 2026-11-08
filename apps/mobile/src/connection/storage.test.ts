import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make } from "./catalog-store";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  let removalFails = false;
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) => {
      if (removalFails) {
        removalFails = false;
        return Effect.fail(
          new MobileSecureStorage.MobileSecureStorageError({
            operation: "delete",
            key,
            cause: "unavailable",
          }),
        );
      }
      return Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      });
    },
  });
  const failNextRemoval = () => {
    removalFails = true;
  };
  return { deleted, failNextRemoval, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect("keeps a catalog it cannot read until an explicit update replaces it", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        schemaVersion: 1,
        targets: [{ _tag: "FutureConnectionTarget", environmentId: "future-environment" }],
        profiles: [],
        credentials: [],
        remoteDpopTokens: [],
      });
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: raw,
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([]);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(raw);

      yield* catalog.update((document) => document);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).not.toBe(raw);
    }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("falls back to legacy data without overwriting a catalog it cannot read", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({
          connections: [
            {
              environmentId: "legacy-environment",
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([]);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe("{not-json");

      memory.failNextRemoval();
      yield* Effect.flip(catalog.update((document) => document));
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).not.toBe("{not-json");
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(true);

      yield* catalog.update((document) => document);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );
});
