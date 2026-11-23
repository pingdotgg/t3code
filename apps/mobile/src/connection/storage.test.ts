import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  DpopConnectionCredential,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  Persistence,
  recoverProvisionalPairings,
  settleProvisionalPairingInCatalog,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
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
import * as ConnectionStorage from "./storage";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

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

function failFirstCatalogRead(memory: ReturnType<typeof makeStorage>) {
  let failOnce = true;
  return MobileSecureStorage.MobileSecureStorage.of({
    ...memory.storage,
    getItem: (key) =>
      Effect.suspend(() => {
        if (!failOnce || key !== CONNECTION_CATALOG_KEY) return memory.storage.getItem(key);
        failOnce = false;
        return Effect.fail(
          new MobileSecureStorage.MobileSecureStorageError({
            operation: "read",
            key,
            cause: new Error("secure-storage read interrupted"),
          }),
        );
      }),
  });
}

describe("mobile connection catalog storage", () => {
  const environmentId = EnvironmentId.make("clone");
  const target = new BearerConnectionTarget({
    environmentId,
    label: "Prewarm",
    connectionId: "bearer:orbit-reservation:install",
    provisionalPairingId: "install",
  });
  const profile = new BearerConnectionProfile({
    environmentId,
    label: target.label,
    connectionId: target.connectionId,
    httpBaseUrl: "https://clone.example.test",
    wsBaseUrl: "wss://clone.example.test",
  });
  const credential = {
    connectionId: target.connectionId,
    credential: new BearerConnectionCredential({ token: "stored-session" }),
    provisionalPairingId: "install",
  };
  const dpopCredential = {
    ...credential,
    credential: new DpopConnectionCredential({
      accessToken: "stored-renewable-session",
      expiresAtEpochMs: 1_000,
    }),
  };

  it.effect(
    "retries a failed startup read and durably removes the abandoned route and credential",
    () =>
      Effect.gen(function* () {
        const memory = makeStorage({
          [CONNECTION_CATALOG_KEY]: encodeCatalog({
            ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
            targets: [target],
            credentials: [credential],
          }),
        });
        const services = yield* Layer.build(ConnectionStorage.layer).pipe(
          Effect.provideService(
            MobileSecureStorage.MobileSecureStorage,
            failFirstCatalogRead(memory),
          ),
        );
        expect(yield* Context.get(services, Persistence.ConnectionTargetStore).list).toEqual([]);
        yield* TestClock.adjust("10 seconds");
        expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(
          encodeCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT),
        );
      }),
  );

  it.effect.each([
    {
      scenario: "credential-only",
      targets: [],
      profiles: [],
      credentials: [credential],
      promote: false,
    },
    { scenario: "route-only", targets: [target], profiles: [], credentials: [], promote: false },
    {
      scenario: "different connection ids",
      targets: [target],
      profiles: [profile],
      credentials: [{ ...credential, connectionId: "other-route" }],
      promote: false,
    },
    {
      scenario: "missing endpoint profile",
      targets: [target],
      profiles: [],
      credentials: [credential],
      promote: false,
    },
    {
      scenario: "wrong endpoint environment",
      targets: [target],
      profiles: [
        new BearerConnectionProfile({
          ...profile,
          environmentId: EnvironmentId.make("other-environment"),
        }),
      ],
      credentials: [credential],
      promote: false,
    },
    {
      scenario: "complete bearer",
      targets: [target],
      profiles: [profile],
      credentials: [credential],
      promote: true,
    },
    {
      scenario: "complete renewable DPoP",
      targets: [target],
      profiles: [profile],
      credentials: [dpopCredential],
      promote: true,
    },
  ] as const)(
    "settles a $scenario install without losing ownership on failure",
    ({ targets, profiles, credentials, promote }) =>
      Effect.gen(function* () {
        const pending = encodeCatalog({
          ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
          targets,
          profiles,
          credentials,
        });
        const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: pending });
        // Fail the startup read so the settlement sees the injected install before recovery.
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const running = yield* Layer.build(ConnectionStorage.layer).pipe(
              Effect.provideService(
                MobileSecureStorage.MobileSecureStorage,
                failFirstCatalogRead(memory),
              ),
            );
            const store = Context.get(running, Persistence.ConnectionRegistrationStore);
            return yield* store.settleProvisionalPairing(environmentId, "install", true);
          }),
        );
        const committed = promote
          ? {
              ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
              targets: [
                new BearerConnectionTarget({
                  environmentId,
                  label: target.label,
                  connectionId: target.connectionId,
                }),
              ],
              profiles,
              // The promotion names its pairing, so only that session's late renewal is kept.
              credentials: credentials.map(({ provisionalPairingId: _owner, ...entry }) => ({
                ...entry,
                promotedPairingId: "install",
              })),
            }
          : EMPTY_CONNECTION_CATALOG_DOCUMENT;
        expect(result.promoted).toBe(promote);
        expect(result.routes).toEqual(promote ? committed.targets : targets);
        expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(
          promote ? encodeCatalog(committed) : pending,
        );

        const restarted = yield* Layer.build(ConnectionStorage.layer).pipe(
          Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
        );
        expect(yield* Context.get(restarted, Persistence.ConnectionTargetStore).list).toEqual(
          committed.targets,
        );
        expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(encodeCatalog(committed));
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

  it.effect("replays an abandoned install after a failed secure-storage commit and restart", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("clone");
      const target = new BearerConnectionTarget({
        environmentId,
        label: "provisional",
        connectionId: "route",
        provisionalPairingId: "install",
      });
      const credential = new BearerConnectionCredential({ token: "stored-session" });
      const pending = {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        targets: [target],
        credentials: [{ connectionId: "route", credential, provisionalPairingId: "install" }],
      };
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: encodeCatalog(pending) });
      const failingStore = MobileSecureStorage.MobileSecureStorage.of({
        ...memory.storage,
        setItem: (key) =>
          Effect.fail(
            new MobileSecureStorage.MobileSecureStorageError({
              operation: "write",
              key,
              cause: new Error("secure-storage write interrupted"),
            }),
          ),
      });
      const old = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, failingStore),
      );
      yield* old
        .update((doc) => settleProvisionalPairingInCatalog(doc, "install", false))
        .pipe(Effect.flip);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(encodeCatalog(pending));

      const restarted = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );
      yield* recoverProvisionalPairings(restarted);
      expect(yield* restarted.read).toEqual(EMPTY_CONNECTION_CATALOG_DOCUMENT);
      yield* recoverProvisionalPairings(restarted);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(
        encodeCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT),
      );
    }),
  );

  it.effect(
    "keeps a promoted pairing across restart and ignores replay of the old install id",
    () =>
      Effect.gen(function* () {
        const memory = makeStorage({});
        const open = () =>
          make().pipe(
            Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
          );
        const store = yield* open();
        yield* store.update((doc) => ({
          ...doc,
          targets: [target],
          profiles: [profile],
          credentials: [credential],
        }));
        yield* store.update((doc) => settleProvisionalPairingInCatalog(doc, "install", true));

        const restarted = yield* open();
        yield* recoverProvisionalPairings(restarted);
        yield* restarted.update((doc) => settleProvisionalPairingInCatalog(doc, "install", false));
        const saved = yield* restarted.read;
        expect(saved.targets).toEqual([
          new BearerConnectionTarget({
            environmentId,
            label: target.label,
            connectionId: target.connectionId,
          }),
        ]);
        expect(saved.profiles).toEqual([profile]);
        expect(saved.credentials).toEqual([
          {
            connectionId: target.connectionId,
            credential: credential.credential,
            promotedPairingId: "install",
          },
        ]);
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
          ],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);

      yield* catalog.update((document) => document);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
    }),
  );
});
