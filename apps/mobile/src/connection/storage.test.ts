import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "@t3tools/client-runtime/platform";
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
  const storage = MobileSecureStorage.MobileSecureStorage.of({
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
  it.effect(
    "restores a direct tailnet connection after cold start and forgets it after removal",
    () =>
      Effect.gen(function* () {
        const memory = makeStorage({});
        const open = () =>
          make().pipe(
            Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
          );
        const environmentId = EnvironmentId.make("owner-mac");
        const target = new BearerConnectionTarget({
          environmentId,
          label: "Mac",
          connectionId: "direct-mac",
        });
        const profile = new BearerConnectionProfile({
          connectionId: target.connectionId,
          environmentId,
          label: "Mac",
          httpBaseUrl: "https://mac.tailnet.ts.net",
          wsBaseUrl: "wss://mac.tailnet.ts.net",
        });
        const credential = new BearerConnectionCredential({ token: "server-issued-session" });
        const firstLaunch = yield* open();
        yield* firstLaunch.update((document) =>
          registerConnectionInCatalog(
            document,
            new BearerConnectionRegistration({ target, profile, credential }),
          ),
        );
        const coldStart = yield* open();
        const restored = yield* coldStart.read;
        expect(restored.targets).toEqual([target]);
        expect(restored.profiles).toEqual([profile]);
        expect(restored.credentials).toEqual([{ connectionId: target.connectionId, credential }]);
        yield* coldStart.update((document) =>
          removeConnectionFromCatalog(document, target.environmentId),
        );
        const afterRemoval = yield* (yield* open()).read;
        expect(afterRemoval.targets).toEqual([]);
        expect(afterRemoval.credentials).toEqual([]);
      }),
  );

  it.effect("recovers from a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
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
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
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
            {
              environmentId: "connect-environment",
              environmentLabel: "Cloud Mac",
              pairingUrl: "https://relay.example.test",
              displayUrl: "https://relay.example.test",
              httpBaseUrl: "https://relay.example.test",
              wsBaseUrl: "wss://relay.example.test",
              bearerToken: null,
              authenticationMethod: "dpop",
              dpopAccessToken: "relay-minted-token",
              relayManaged: true,
            },
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      const migrated = yield* catalog.read;
      expect(migrated.targets.map((target) => target.environmentId)).toEqual([
        "legacy-environment",
      ]);
      expect(migrated.connectOnlyEnvironments).toEqual([
        { environmentId: "connect-environment", label: "Cloud Mac" },
      ]);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).not.toContain("relay-minted-token");
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );
});
