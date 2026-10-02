import { describe, expect, it } from "@effect/vitest";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import {
  CONNECTION_CATALOG_BACKUP_KEY,
  CONNECTION_CATALOG_KEY,
  LEGACY_CONNECTIONS_KEY,
  make,
} from "./catalog-store";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";

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
  const encodedCatalog = Schema.encodeEffect(Schema.fromJsonString(ConnectionCatalogDocument));
  const fixtureCatalog = registerConnectionInCatalog(
    EMPTY_CONNECTION_CATALOG_DOCUMENT,
    new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: EnvironmentId.make("saved-environment"),
        label: "Saved environment",
        connectionId: "bearer:saved-environment",
      }),
      profile: new BearerConnectionProfile({
        connectionId: "bearer:saved-environment",
        environmentId: EnvironmentId.make("saved-environment"),
        label: "Saved environment",
        httpBaseUrl: "https://saved.example.test",
        wsBaseUrl: "wss://saved.example.test",
      }),
      credential: new BearerConnectionCredential({ token: "saved-token" }),
    }),
  );

  it.effect("recovers a corrupt current catalog from its durable backup", () =>
    Effect.gen(function* () {
      const encoded = yield* encodedCatalog(fixtureCatalog);
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [CONNECTION_CATALOG_BACKUP_KEY]: encoded,
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(encoded);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("fails closed without deleting a corrupt catalog when no backup exists", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const error = yield* Effect.flip(catalog.read);
      expect(error.detail).toContain("No valid connection catalog backup is available");
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe("{not-json");
      expect(memory.deleted).toEqual([]);
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
      expect(memory.values.has(CONNECTION_CATALOG_BACKUP_KEY)).toBe(true);
    }),
  );

  it.effect("restores a missing current catalog from backup before consulting legacy data", () =>
    Effect.gen(function* () {
      const encoded = yield* encodedCatalog(fixtureCatalog);
      const memory = makeStorage({
        [CONNECTION_CATALOG_BACKUP_KEY]: encoded,
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
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(encoded);
      expect(memory.deleted).toEqual([]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(CONNECTION_CATALOG_BACKUP_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(true);
    }),
  );
});
