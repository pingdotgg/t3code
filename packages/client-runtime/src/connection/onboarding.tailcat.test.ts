import { EnvironmentId, type TailcatAddress, type TailcatNodeKey } from "@t3tools/contracts";
import { encodeTailcatConnectionCode } from "@t3tools/shared/t3ConnectionCode";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  ClientPresentation,
  SshEnvironmentGateway,
  TailcatEnvironmentGateway,
} from "../platform/capabilities.ts";
import { ConnectionPersistenceError } from "../platform/persistence.ts";
import { ConnectionCredentialStore } from "./credentialStore.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  ConnectionTransientError,
  type ConnectionAttemptError,
  type NetworkStatus,
} from "./model.ts";
import * as Onboarding from "./onboarding.ts";
import { prepareTailcatRegistration } from "./onboarding.ts";
import { EnvironmentRegistry } from "./registry.ts";

const ADDRESS =
  "tco2FwWCBsyGP41dXrPe-jN6lGVysle1gLOeO06eQXFFnAEyTVWmFrWCBXI4Jlw0AzfV9loUv7embdWaR2qZD6dhGPBqQDMD1-a2FpGQEu" as TailcatAddress;
const NODE_KEY = `nodekey:${"ab".repeat(32)}` as TailcatNodeKey;
const ENVIRONMENT_ID = EnvironmentId.make("environment-tailcat");
const CONNECTION_ID = `tailcat:${ENVIRONMENT_ID}`;

const cryptoLayer = Layer.effect(
  Crypto.Crypto,
  Effect.sync(() => {
    let next = 0;
    return Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill(++next),
      digest: (_algorithm, data) => Effect.succeed(data),
    });
  }),
);

const code = (options: { readonly withPairingToken?: boolean } = {}) =>
  encodeTailcatConnectionCode({
    v: 1,
    transport: "tailcat",
    address: ADDRESS,
    port: 47831,
    environmentId: ENVIRONMENT_ID,
    name: "gpu-box",
    serverVersion: "0.0.38",
    ...(options.withPairingToken === false ? {} : { pairingToken: "PAIRTOKEN123" }),
    expiresAt: "2026-09-03T20:05:21.215Z",
  });

const gateway = (environmentId: EnvironmentId = ENVIRONMENT_ID) =>
  TailcatEnvironmentGateway.of({
    provision: ({ payload, connectionId }) =>
      Effect.succeed({
        environmentId,
        label: "GPU box",
        bootstrap: {
          connectionId,
          address: payload.address,
          remotePort: payload.port,
          localPort: 48831,
          httpBaseUrl: "http://127.0.0.1:48831",
          wsBaseUrl: "ws://127.0.0.1:48831",
          clientNodeKey: NODE_KEY,
        },
        bearerToken: "bearer-token",
      }),
    prepare: () => Effect.die("unused"),
    disconnect: () => Effect.void,
  });

function trackedGateway(options?: {
  readonly afterProvision?: (connectionId: string) => Effect.Effect<void, ConnectionAttemptError>;
  readonly disconnectError?: ConnectionAttemptError;
}) {
  const active = new Set<string>();
  const provisioned: Array<string> = [];
  const disconnected: Array<string> = [];
  const service = TailcatEnvironmentGateway.of({
    ...gateway(),
    provision: Effect.fn(function* (input) {
      active.add(input.connectionId);
      provisioned.push(input.connectionId);
      yield* options?.afterProvision?.(input.connectionId) ?? Effect.void;
      return yield* gateway().provision(input);
    }),
    disconnect: Effect.fn(function* (connectionId) {
      disconnected.push(connectionId);
      if (options?.disconnectError !== undefined) return yield* options.disconnectError;
      active.delete(connectionId);
    }),
  });
  return { service, active, provisioned, disconnected };
}

const makeOnboarding = Effect.fn(function* (
  tailcat: TailcatEnvironmentGateway["Service"],
  register: EnvironmentRegistry["Service"]["register"],
) {
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
  return yield* Onboarding.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(TailcatEnvironmentGateway, tailcat),
        Layer.mock(EnvironmentRegistry)({ register, entries, networkStatus }),
        Layer.succeed(ClientPresentation, { metadata: {}, scopes: [] }),
        Layer.mock(SshEnvironmentGateway)({}),
        Layer.mock(ConnectionCredentialStore)({}),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unused")),
        ),
      ),
    ),
  );
});

it.layer(cryptoLayer)("tailcat onboarding", (it) => {
  it.effect("registers the logical Tailcat endpoint, never the local forward port", () =>
    Effect.gen(function* () {
      const registration = yield* prepareTailcatRegistration({ code: code() }).pipe(
        Effect.provideService(TailcatEnvironmentGateway, gateway()),
      );

      expect(registration).toMatchObject({
        _tag: "TailcatConnectionRegistration",
        target: {
          _tag: "TailcatConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "GPU box",
          connectionId: `tailcat:${ENVIRONMENT_ID}`,
        },
        profile: {
          _tag: "TailcatConnectionProfile",
          connectionId: `tailcat:${ENVIRONMENT_ID}`,
          address: ADDRESS,
          remotePort: 47831,
        },
        credential: { _tag: "BearerConnectionCredential", token: "bearer-token" },
      });
      expect(Object.values(registration.profile)).not.toContain(48831);
    }),
  );

  it.effect("prefers an explicit label over the descriptor label", () =>
    Effect.gen(function* () {
      const registration = yield* prepareTailcatRegistration({
        code: code(),
        label: "  Office box ",
      }).pipe(Effect.provideService(TailcatEnvironmentGateway, gateway()));
      expect(registration.target.label).toBe("Office box");
    }),
  );

  it.effect("refuses a code whose environment differs from the machine that answered", () =>
    Effect.gen(function* () {
      const result = yield* prepareTailcatRegistration({ code: code() }).pipe(
        Effect.provideService(
          TailcatEnvironmentGateway,
          gateway(EnvironmentId.make("environment-other")),
        ),
        Effect.flip,
      );
      expect(result).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
    }),
  );

  it.effect("refuses a code without a pairing credential before opening a tunnel", () =>
    Effect.gen(function* () {
      let provisioned = false;
      const result = yield* prepareTailcatRegistration({
        code: code({ withPairingToken: false }),
      }).pipe(
        Effect.provideService(
          TailcatEnvironmentGateway,
          TailcatEnvironmentGateway.of({
            provision: () =>
              Effect.sync(() => {
                provisioned = true;
              }).pipe(Effect.andThen(Effect.die("unreachable"))),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
        Effect.flip,
      );
      expect(result).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
      });
      expect(provisioned).toBe(false);
    }),
  );

  it.effect("explains an invalid or foreign code", () =>
    Effect.gen(function* () {
      const notACode = yield* prepareTailcatRegistration({ code: "https://example.com/pair" }).pipe(
        Effect.provideService(TailcatEnvironmentGateway, gateway()),
        Effect.flip,
      );
      expect(notACode).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });

      const peerCode = yield* prepareTailcatRegistration({ code: "t3c://peer/eyJ2IjoxfQ" }).pipe(
        Effect.provideService(TailcatEnvironmentGateway, gateway()),
        Effect.flip,
      );
      expect(peerCode).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(peerCode.detail).toMatch(/peer|Tailcat connection code/iu);
    }),
  );

  it.effect("cleans up failed registration without disconnecting a saved environment", () =>
    Effect.gen(function* () {
      const tracked = trackedGateway();
      tracked.active.add(CONNECTION_ID);
      const persistenceError = new ConnectionPersistenceError({
        operation: "register-connection",
        message: "Storage unavailable",
      });
      const onboarding = yield* makeOnboarding(tracked.service, () =>
        Effect.fail(persistenceError),
      );

      const error = yield* onboarding.registerTailcat({ code: code() }).pipe(Effect.flip);

      expect(error).toBe(persistenceError);
      expect(tracked.provisioned).toHaveLength(1);
      expect(tracked.provisioned[0]).not.toBe(CONNECTION_ID);
      expect(tracked.disconnected).toEqual(tracked.provisioned);
      expect([...tracked.active]).toEqual([CONNECTION_ID]);
    }),
  );

  it.effect("preserves a registration failure when temporary-forward cleanup also fails", () =>
    Effect.gen(function* () {
      const tracked = trackedGateway({
        disconnectError: new ConnectionTransientError({
          reason: "tailcat-unavailable",
          detail: "IPC unavailable",
        }),
      });
      const persistenceError = new ConnectionPersistenceError({
        operation: "register-connection",
        message: "Storage unavailable",
      });
      const onboarding = yield* makeOnboarding(tracked.service, () =>
        Effect.fail(persistenceError),
      );

      const error = yield* onboarding.registerTailcat({ code: code() }).pipe(Effect.flip);

      expect(error).toBe(persistenceError);
      expect(tracked.disconnected).toEqual(tracked.provisioned);
    }),
  );

  it.effect("cleans up a forward when provisioning fails after starting it", () =>
    Effect.gen(function* () {
      const pairingError = new ConnectionTransientError({
        reason: "tailcat-unavailable",
        detail: "Pairing failed",
      });
      const tracked = trackedGateway({ afterProvision: () => Effect.fail(pairingError) });
      const onboarding = yield* makeOnboarding(tracked.service, () =>
        Effect.die("must not register"),
      );

      const error = yield* onboarding.registerTailcat({ code: code() }).pipe(Effect.flip);

      expect(error).toBe(pairingError);
      expect(tracked.disconnected).toEqual(tracked.provisioned);
      expect(tracked.active.size).toBe(0);
    }),
  );

  it.effect("keeps a concurrently registered connection when an older pairing attempt fails", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      let attempts = 0;
      const tracked = trackedGateway({
        afterProvision: () =>
          ++attempts === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
              )
            : Effect.void,
      });
      const persistenceError = new ConnectionPersistenceError({
        operation: "register-connection",
        message: "First registration failed",
      });
      const onboarding = yield* makeOnboarding(tracked.service, (registration) =>
        registration.target.label === "first"
          ? Effect.fail(persistenceError)
          : Effect.sync(() => {
              // The registry installs the canonical target after persistence.
              expect(registration._tag).toBe("TailcatConnectionRegistration");
              if (registration._tag !== "TailcatConnectionRegistration")
                throw new Error("Expected Tailcat");
              expect(registration.target.connectionId).toBe(CONNECTION_ID);
              tracked.active.add(CONNECTION_ID);
            }),
      );
      const first = yield* onboarding
        .registerTailcat({ code: code(), label: "first" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(firstStarted);

      expect(yield* onboarding.registerTailcat({ code: code(), label: "second" })).toBe(
        ENVIRONMENT_ID,
      );
      expect(new Set(tracked.provisioned).size).toBe(2);
      expect(tracked.active.has(tracked.provisioned[0]!)).toBe(true);
      expect(tracked.active.has(CONNECTION_ID)).toBe(true);

      yield* Deferred.succeed(releaseFirst, undefined);
      expect(yield* Fiber.join(first)).toBe(persistenceError);
      expect([...tracked.active]).toEqual([CONNECTION_ID]);
      expect(tracked.disconnected).toHaveLength(2);
    }),
  );

  it.effect("stops an interrupted pairing forward", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const tracked = trackedGateway({
        afterProvision: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const onboarding = yield* makeOnboarding(tracked.service, () =>
        Effect.die("must not register"),
      );
      const attempt = yield* onboarding.registerTailcat({ code: code() }).pipe(Effect.forkChild);
      yield* Deferred.await(started);

      yield* Fiber.interrupt(attempt);

      expect(tracked.disconnected).toEqual(tracked.provisioned);
      expect(tracked.active.size).toBe(0);
    }),
  );
});
