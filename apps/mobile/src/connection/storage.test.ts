import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import {
  MobileSecureStorage,
  MobileSecureStorageError,
} from "../persistence/mobile-secure-storage";

/** In-memory MobileSecureStorage double for catalog persist tests. */
function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const storage = MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect("recovers from a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY]);
    }),
  );

  it.effect("replaces and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: JSON.stringify({ connections: [{ invalid: true }] }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toEqual([]);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
    }),
  );

  it.effect("falls back to valid legacy data when the current catalog is corrupt", () =>
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
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );

  /** Catalog update must leave the previous document when Keychain write fails. */
  it.effect("keeps a saved environment when a catalog write fails", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      let failWrite = false;
      const storage = MobileSecureStorage.of({
        getItem: (key) => Effect.sync(() => values.get(key) ?? null),
        setItem: (key, value) =>
          Effect.gen(function* () {
            if (failWrite) {
              return yield* new MobileSecureStorageError({
                operation: "write",
                key,
                cause: new Error("keychain write failed"),
              });
            }
            values.set(key, value);
          }),
        removeItem: (key) =>
          Effect.sync(() => {
            values.delete(key);
          }),
      });
      const catalog = yield* make().pipe(Effect.provideService(MobileSecureStorage, storage));
      const environmentId = EnvironmentId.make("offline-direct");

      yield* catalog.update((document) => ({
        ...document,
        targets: [
          new BearerConnectionTarget({
            environmentId,
            label: "Stale Mac",
            connectionId: "bearer-offline-direct",
          }),
        ],
      }));
      expect((yield* catalog.read).targets).toHaveLength(1);

      failWrite = true;
      const removed = yield* catalog
        .update((document) => ({ ...document, targets: [] }))
        .pipe(Effect.exit);

      expect(Exit.isFailure(removed)).toBe(true);
      expect((yield* catalog.read).targets).toHaveLength(1);
      expect((yield* catalog.read).targets[0]?.environmentId).toBe(environmentId);
    }),
  );
});
