import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AuthConnectClients from "../persistence/AuthConnectClients.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as ConnectClientStore from "./ConnectClientStore.ts";

const textEncoder = new TextEncoder();
const requestedAt = DateTime.makeUnsafe("2026-06-27T12:00:00.000Z");
const approvedAt = DateTime.makeUnsafe("2026-06-27T12:05:00.000Z");
const rejectedAt = DateTime.makeUnsafe("2026-06-27T12:06:00.000Z");

const approvedRecord: AuthConnectClients.AuthConnectClientRecord = {
  clientProofKeyThumbprint: "client-thumbprint",
  cloudUserId: "cloud-user",
  deviceId: "device-1",
  status: "approved",
  client: {
    label: "Client",
    ipAddress: null,
    userAgent: null,
    deviceType: "desktop",
    os: "macOS",
    browser: null,
  },
  requestedAt,
  updatedAt: approvedAt,
  approvedAt,
  rejectedAt: null,
  revokedAt: null,
  lastSeenAt: null,
};
const pendingRecord: AuthConnectClients.AuthConnectClientRecord = {
  ...approvedRecord,
  status: "pending",
  updatedAt: requestedAt,
  approvedAt: null,
  lastSeenAt: null,
};

const makeSecretStoreLayer = (mode: string) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.some(textEncoder.encode(mode))),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

const secretStoreLayer = makeSecretStoreLayer("client-approval");

const makeStoreOnlyLayer = (mode: string) =>
  Layer.effect(ConnectClientStore.ConnectClientStore, ConnectClientStore.make).pipe(
    Layer.provide(makeSecretStoreLayer(mode)),
    Layer.provide(
      Layer.succeed(
        AuthConnectClients.AuthConnectClientRepository,
        AuthConnectClients.AuthConnectClientRepository.of({
          upsertRequest: () => Effect.succeed(approvedRecord),
          updateStatus: () => Effect.succeed(Option.none()),
          revoke: () => Effect.succeed(false),
          markSeen: () => Effect.succeed(Option.some(approvedRecord)),
          listActive: () => Effect.succeed([]),
        }),
      ),
    ),
  );

const makeStoreLayer = (
  overrides: Partial<AuthConnectClients.AuthConnectClientRepository["Service"]>,
) =>
  Layer.effect(ConnectClientStore.ConnectClientStore, ConnectClientStore.make).pipe(
    Layer.provide(secretStoreLayer),
    Layer.provide(
      Layer.succeed(
        AuthConnectClients.AuthConnectClientRepository,
        AuthConnectClients.AuthConnectClientRepository.of({
          upsertRequest: () => Effect.succeed(approvedRecord),
          updateStatus: () => Effect.succeed(Option.none()),
          revoke: () => Effect.succeed(false),
          markSeen: () => Effect.succeed(Option.some(approvedRecord)),
          listActive: () => Effect.succeed([]),
          ...overrides,
        }),
      ),
    ),
  );

it.effect("fails closed when persisted security mode is invalid", () =>
  Effect.gen(function* () {
    const store = yield* ConnectClientStore.ConnectClientStore;
    const error = yield* Effect.flip(store.getSecurityMode());

    expect(error._tag).toBe("ConnectSecurityModeLoadError");
    expect(error.invalidValue).toBe("invalid-mode");
  }).pipe(Effect.provide(makeStoreOnlyLayer("invalid-mode"))),
);

it.effect("returns rejected when an approved client is rejected before last-seen update", () =>
  Effect.gen(function* () {
    const store = yield* ConnectClientStore.ConnectClientStore;
    const authorization = yield* store.requestClient({
      cloudUserId: "cloud-user",
      clientProofKeyThumbprint: "client-thumbprint",
    });

    expect(authorization.mode).toBe("client-approval");
    expect(authorization.status).toBe("rejected");
  }).pipe(
    Effect.provide(
      makeStoreLayer({
        markSeen: () =>
          Effect.succeed(
            Option.some({
              ...approvedRecord,
              status: "rejected",
              updatedAt: rejectedAt,
              rejectedAt,
            }),
          ),
      }),
    ),
  ),
);

it.effect(
  "re-registers a pending client when an approved client is revoked before last-seen update",
  () => {
    const upsertInputs: Array<AuthConnectClients.UpsertAuthConnectClientRequestInput> = [];

    return Effect.gen(function* () {
      const store = yield* ConnectClientStore.ConnectClientStore;
      const changesFiber = yield* store.streamChanges.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const authorization = yield* store.requestClient({
        cloudUserId: "cloud-user",
        clientProofKeyThumbprint: "client-thumbprint",
      });
      const changes = Array.from(yield* Fiber.join(changesFiber));

      expect(authorization.mode).toBe("client-approval");
      expect(authorization.status).toBe("pending");
      expect(upsertInputs).toHaveLength(2);
      if (authorization.mode === "client-approval") {
        expect(authorization.client.status).toBe("pending");
        expect(authorization.client.approvedAt).toBeNull();
        expect(authorization.client.lastSeenAt).toBeNull();
      }
      expect(changes.map((change) => change.type)).toEqual([
        "connectClientUpserted",
        "connectClientUpserted",
      ]);
      expect(changes[1]?.type === "connectClientUpserted" ? changes[1].client.status : null).toBe(
        "pending",
      );
    }).pipe(
      Effect.provide(
        makeStoreLayer({
          upsertRequest: (input) =>
            Effect.sync(() => {
              upsertInputs.push(input);
              return upsertInputs.length === 1
                ? approvedRecord
                : {
                    ...pendingRecord,
                    requestedAt: input.requestedAt,
                    updatedAt: input.requestedAt,
                  };
            }),
          markSeen: () => Effect.succeed(Option.none()),
        }),
      ),
    );
  },
);
