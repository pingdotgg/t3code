import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer, type HttpClientRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { EnvironmentId } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import { RelayManagedEndpointRecoveryRegistrationRequest } from "@t3tools/contracts/relay";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  decodeConfirmedOrigin,
  decodeRuntimeConfig,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import * as CloudLink from "./CloudLink.ts";
import { consumeCloudReplayGuards } from "./CloudLink.ts";
import {
  managedTunnelStartupAction,
  retryManagedTunnelRegistration,
} from "./managedTunnelStartup.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new ServerSecretStore.SecretStorePersistError({
    resource: "cloud replay guard",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "cloud-replay-guard.bin",
    }),
  });

const unusedSecretStoreOperation = () => Effect.die("unused secret-store operation");

const idleAwarenessRelay = AgentAwarenessRelay.AgentAwarenessRelay.of({
  publishThread: () => Effect.void,
  drain: Effect.void,
  requestCatchUp: () => Effect.void,
  start: () => Effect.void,
});

const idleHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const decodeManagedTunnelRecoveryRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayManagedEndpointRecoveryRegistrationRequest),
);

function makeSecretStore(
  create: ServerSecretStore.ServerSecretStore["Service"]["create"],
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: unusedSecretStoreOperation,
  };
}

it("preserves messages surfaced by cloud 500 responses", () => {
  const cause = new Error("cloud operation failed");

  expect([
    new EnvironmentAuth.ServerAuthLinkedCloudAccountVerificationError({ cause }).message,
    new EnvironmentAuth.ServerAuthLinkedCloudAccountReadError({ cause }).message,
    new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({}).message,
    new EnvironmentAuth.ServerAuthCloudLinkJwtSigningError({ cause }).message,
    new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({}).message,
    new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({}).message,
    new EnvironmentAuth.ServerAuthCloudHealthJwtSigningError({ cause }).message,
    new EnvironmentAuth.ServerAuthCloudMintJwtSigningError({ cause }).message,
  ]).toEqual([
    "Could not verify the linked cloud account.",
    "Could not read the linked cloud account.",
    "Cloud linked user is not installed for this environment.",
    "Failed to sign cloud link JWT.",
    "Cloud mint public key is not installed for this environment.",
    "Cloud relay issuer is not installed for this environment.",
    "Failed to sign cloud health JWT.",
    "Failed to sign cloud mint JWT.",
  ]);
});

describe("consumeCloudReplayGuards", () => {
  it.effect("reports already-created guards as replay conflicts", () =>
    Effect.gen(function* () {
      const consumed = yield* consumeCloudReplayGuards({
        secrets: makeSecretStore(() => Effect.fail(storeFailure("AlreadyExists"))),
        names: ["cloud-jti", "cloud-nonce"],
        value: new Uint8Array(),
      });

      expect(consumed).toBe(false);
    }),
  );

  it.effect("preserves replay-store availability failures", () =>
    Effect.gen(function* () {
      const failure = storeFailure("PermissionDenied");
      const error = yield* Effect.flip(
        consumeCloudReplayGuards({
          secrets: makeSecretStore(() => Effect.fail(failure)),
          names: ["cloud-jti", "cloud-nonce"],
          value: new Uint8Array(),
        }),
      );

      expect(error).toBe(failure);
    }),
  );
});

describe("reconcileDesiredCloudLink", () => {
  it.effect("requires stored CLI authorization without exposing an HTTP endpoint", () =>
    Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const error = yield* Effect.flip(link.reconcileDesiredLink("http://127.0.0.1:3774"));

      expect(error._tag).toBe("CloudLinkAuthorizationMissingError");
    }).pipe(
      Effect.provide(CloudLink.layer),
      Effect.provideService(HttpServer.HttpServer, idleHttpServer),
      Effect.provideService(
        ServerSecretStore.ServerSecretStore,
        makeSecretStore(unusedSecretStoreOperation),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: unusedSecretStoreOperation(),
          getDescriptor: unusedSecretStoreOperation(),
        }),
      ),
      Effect.provideService(
        ManagedEndpointRuntime.CloudManagedEndpointRuntime,
        ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
          applyConfig: unusedSecretStoreOperation,
          recoveryRequests: Stream.empty,
          requestRecovery: () => Effect.void,
          tunnelConnected: Stream.empty,
          withLinkStateLock: (effect) => effect,
        } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"]),
      ),
      Effect.provideService(
        EnvironmentAuth.EnvironmentAuth,
        EnvironmentAuth.EnvironmentAuth.of({} as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Effect.provideService(
        CliTokenManager.CloudCliTokenManager,
        CliTokenManager.CloudCliTokenManager.of({
          get: unusedSecretStoreOperation(),
          getExisting: Effect.succeedNone,
          hasCredential: unusedSecretStoreOperation(),
          store: () => unusedSecretStoreOperation(),
          clear: unusedSecretStoreOperation(),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => unusedSecretStoreOperation()),
      ),
      Effect.provideService(AgentAwarenessRelay.AgentAwarenessRelay, idleAwarenessRelay),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("managed tunnel recovery", () => {
  const cliToken: CliTokenManager.PersistedToken = {
    accessToken: "cli-access-token",
    refreshToken: "cli-refresh-token",
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };

  function makeMemorySecretStore(initial: Iterable<readonly [string, string]> = []) {
    const values = new Map<string, Uint8Array>(
      Array.from(initial, ([name, value]) => [name, new TextEncoder().encode(value)] as const),
    );
    const store: ServerSecretStore.ServerSecretStore["Service"] = {
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      getOrCreateRandom: unusedSecretStoreOperation,
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
    };
    return { store, values };
  }

  interface RecoveryHarness {
    readonly store: ServerSecretStore.ServerSecretStore["Service"];
    readonly applyConfigCalls: Array<unknown>;
    readonly requests: Array<HttpClientRequest.HttpClientRequest>;
    readonly onRequest?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>;
    readonly respond?: () => Response;
    readonly respondEffect?: Effect.Effect<Response>;
  }

  const provideRecoveryHarness =
    (harness: RecoveryHarness) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(CloudLink.layer),
        Effect.provideService(HttpServer.HttpServer, idleHttpServer),
        Effect.provideService(ServerSecretStore.ServerSecretStore, harness.store),
        Effect.provideService(AgentAwarenessRelay.AgentAwarenessRelay, idleAwarenessRelay),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env_123")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provideService(
          ManagedEndpointRuntime.CloudManagedEndpointRuntime,
          ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
            applyConfig: (config) =>
              Effect.sync(() => {
                harness.applyConfigCalls.push(config);
                return config === null
                  ? ({
                      status: "disabled",
                    } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus)
                  : ({
                      status: "running",
                      providerKind: "cloudflare_tunnel",
                      pid: 123,
                    } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus);
              }),
            recoveryRequests: Stream.empty,
            requestRecovery: () => Effect.void,
            tunnelConnected: Stream.empty,
            withLinkStateLock: (effect) => effect,
          }),
        ),
        Effect.provideService(
          EnvironmentAuth.EnvironmentAuth,
          EnvironmentAuth.EnvironmentAuth.of({} as EnvironmentAuth.EnvironmentAuth["Service"]),
        ),
        Effect.provideService(
          CliTokenManager.CloudCliTokenManager,
          CliTokenManager.CloudCliTokenManager.of({
            get: unusedSecretStoreOperation(),
            getExisting: Effect.succeedSome(cliToken),
            hasCredential: unusedSecretStoreOperation(),
            store: () => unusedSecretStoreOperation(),
            clear: unusedSecretStoreOperation(),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              harness.requests.push(request);
            }).pipe(
              Effect.andThen(harness.onRequest?.(request) ?? Effect.void),
              Effect.andThen(
                harness.respondEffect ??
                  Effect.sync(() => (harness.respond ?? (() => Response.json({ ok: true })))()),
              ),
              Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
            ),
          ),
        ),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      );

  // The persisted state of a CLI-managed link.
  const managedLinkSecrets = [
    [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
    [CLOUD_ENDPOINT_CONFIRMED_ORIGIN, "confirmed-origin"],
    [RELAY_URL_SECRET, "https://relay.example.test"],
    [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
  ] as const;

  it.effect("does not recreate a link that was unlinked while startup registration retried", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;

      values.delete(CLOUD_CLI_DESIRED_LINK_SECRET);

      expect(yield* link.reconcileDesiredLinkIfStillDesired("http://127.0.0.1:3773")).toBeNull();
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(provideRecoveryHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("registers an existing tunnel and starts the confirmed connector", () => {
    const { store } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toMatchObject({
        status: "ready",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe(
        "https://relay.example.test/v1/environments/env_123/tunnel/recovery",
      );
      expect(requests[0]?.headers.authorization).toBe("Bearer environment-credential");
      const body = requests[0]?.body;
      expect(body?._tag).toBe("Uint8Array");
      if (body?._tag === "Uint8Array") {
        expect(
          yield* decodeManagedTunnelRecoveryRegistration(new TextDecoder().decode(body.body)),
        ).toMatchObject({
          cloudUserId: "user-123",
          tunnelId: "existing-tunnel",
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        });
      }
      expect(applyConfigCalls).toHaveLength(1);
    }).pipe(
      provideRecoveryHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json({ status: "ready" }),
      }),
    );
  });

  it.effect("marks a link the relay rejects as revoked without dropping or replacing it", () => {
    const { store, values } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
      [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toEqual({
        status: "revoked",
      });
      expect((yield* link.linkState()).linkRevoked).toBe(true);

      expect(requests).toHaveLength(1);
      expect(applyConfigCalls).toEqual([]);
      expect(values.has(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBe(true);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(
      provideRecoveryHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () =>
          Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "not_authorized",
              traceId: "trace-revoked",
            },
            { status: 401 },
          ),
      }),
    );
  });

  it.effect("does not mark a link that was replaced while its rejection was in flight", () => {
    const { store, values } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "old-credential"],
    ]);

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toEqual({
        status: "superseded",
      });
      expect(values.has(CLOUD_LINK_REVOKED)).toBe(false);
    }).pipe(
      provideRecoveryHarness({
        store,
        applyConfigCalls: [],
        requests: [],
        respond: () => {
          values.set(
            RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
            new TextEncoder().encode("replacement-credential"),
          );
          return Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "not_authorized",
              traceId: "trace-stale",
            },
            { status: 401 },
          );
        },
      }),
    );
  });

  it.effect("clears the revoked mark when the environment is linked again", () => {
    const { store } = makeMemorySecretStore([
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "revoked-credential"],
      [CLOUD_LINK_REVOKED, "true"],
    ]);
    const cloudMintPublicKey =
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAqZ2u2LjMoAyG2QTHXmITJ9w6RzZtVUAv394XCcPV0zE=\n-----END PUBLIC KEY-----";

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect((yield* link.linkState()).linkRevoked).toBe(true);
      yield* link.applyRelayConfig({
        relayUrl: "https://relay.example.test",
        cloudUserId: "user-123",
        environmentCredential: "fresh-credential",
        cloudMintPublicKey,
        endpointRuntime: null,
      });
      expect(yield* link.linkState()).toMatchObject({ linked: true, linkRevoked: false });
    }).pipe(provideRecoveryHarness({ store, applyConfigCalls: [], requests: [] }));
  });

  it.effect("reconciles a changed port after a relay outage outlasts the startup fallback", () => {
    const config = {
      providerKind: "cloudflare_tunnel" as const,
      connectorToken: "existing-token",
      tunnelId: "existing-tunnel",
    };
    const { store } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, JSON.stringify(config)],
      [
        CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
        JSON.stringify({
          config,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        }),
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    let relayAvailable = false;
    const localOrigin = "http://127.0.0.1:4884";

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const fallbackStarted = yield* Deferred.make<void>();
      const firstFailure = yield* Deferred.make<void>();
      expect(yield* link.startManagedTunnelIfOriginConfirmed(localOrigin)).toBe(false);
      const registration = yield* Effect.forkChild(
        retryManagedTunnelRegistration(
          link
            .registerManagedTunnelRecovery(localOrigin)
            .pipe(Effect.tapError(() => Deferred.succeed(firstFailure, undefined))),
          CloudLink.shouldRetryCloudLink,
          link
            .startManagedTunnelIfOriginConfirmed(localOrigin, {
              requireConfirmedOrigin: false,
            })
            .pipe(
              Effect.orDie,
              Effect.tap((started) => {
                expect(started).toBe(true);
                return Deferred.succeed(fallbackStarted, undefined);
              }),
              Effect.asVoid,
            ),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(firstFailure);
      yield* TestClock.adjust("15 minutes");
      yield* Effect.raceFirst(
        Deferred.await(fallbackStarted),
        Fiber.join(registration).pipe(
          Effect.andThen(Effect.die("Registration ended before starting the fallback")),
        ),
      );
      expect(applyConfigCalls).toEqual([config]);
      const attemptsBeforeRecovery = requests.length;

      relayAvailable = true;
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(registration)).toMatchObject({ status: "ready" });
      expect(requests.length).toBeGreaterThan(attemptsBeforeRecovery);
      const marker = yield* store.get(CLOUD_ENDPOINT_CONFIRMED_ORIGIN);
      expect(Option.isSome(marker)).toBe(true);
      if (Option.isSome(marker)) {
        expect(
          Option.getOrThrow(decodeConfirmedOrigin(new TextDecoder().decode(marker.value))),
        ).toEqual({
          config,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: 4884 },
        });
      }
    }).pipe(
      provideRecoveryHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () =>
          relayAvailable
            ? Response.json({ status: "ready" })
            : Response.json({ message: "relay unavailable" }, { status: 503 }),
      }),
    );
  });

  it.effect(
    "starts a connector with a marker for the current origin without contacting relay",
    () => {
      const configJson =
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}';
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "existing-token",
        tunnelId: "existing-tunnel",
      };
      const { store } = makeMemorySecretStore([
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, configJson],
        [
          CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
          `{"config":${configJson},"origin":{"localHttpHost":"127.0.0.1","localHttpPort":3773}}`,
        ],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];

      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        expect(yield* link.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:3773")).toBe(true);
        expect(applyConfigCalls).toEqual([config]);
        expect(requests).toEqual([]);
      }).pipe(provideRecoveryHarness({ store, applyConfigCalls, requests }));
    },
  );

  it.effect.each([
    { name: "missing", marker: undefined, origin: "http://127.0.0.1:3773" },
    {
      name: "stale",
      marker:
        '{"config":{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"},"origin":{"localHttpHost":"127.0.0.1","localHttpPort":3773}}',
      origin: "http://127.0.0.1:4884",
    },
  ])("does not start a connector with a $name origin marker", ({ marker, origin }) => {
    const entries: Array<readonly [string, string]> = [
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}',
      ],
    ];
    if (marker !== undefined) entries.push([CLOUD_ENDPOINT_CONFIRMED_ORIGIN, marker]);
    const { store } = makeMemorySecretStore(entries);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.startManagedTunnelIfOriginConfirmed(origin)).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(provideRecoveryHarness({ store, applyConfigCalls, requests }));
  });

  it.effect(
    "starts the stored connector without a marker when confirmation is not required",
    () => {
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "existing-token",
        tunnelId: "existing-tunnel",
      };
      const { store } = makeMemorySecretStore([
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, JSON.stringify(config)],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];

      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        expect(
          yield* link.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:3773", {
            requireConfirmedOrigin: false,
          }),
        ).toBe(true);
        expect(applyConfigCalls).toEqual([config]);
        expect(requests).toEqual([]);
      }).pipe(provideRecoveryHarness({ store, applyConfigCalls, requests }));
    },
  );

  it.effect.each(["replaced", "removed"] as const)(
    "does not activate a tunnel when its runtime config is %s during registration",
    (mutation) => {
      const originalConfig =
        '{"providerKind":"cloudflare_tunnel","connectorToken":"existing-token","tunnelId":"existing-tunnel"}';
      const { store, values } = makeMemorySecretStore([
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, originalConfig],
        [RELAY_URL_SECRET, "https://relay.example.test"],
        [CLOUD_LINKED_USER_ID, "user-123"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];

      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toEqual({
          status: "superseded",
        });
        expect(applyConfigCalls).toEqual([]);
        expect(values.has(CLOUD_ENDPOINT_CONFIRMED_ORIGIN)).toBe(false);
      }).pipe(
        provideRecoveryHarness({
          store,
          applyConfigCalls,
          requests,
          respond: () => {
            if (mutation === "replaced") {
              values.set(
                CLOUD_ENDPOINT_RUNTIME_CONFIG,
                new TextEncoder().encode(
                  '{"providerKind":"cloudflare_tunnel","connectorToken":"fresh-token","tunnelId":"fresh-tunnel"}',
                ),
              );
            } else {
              values.delete(CLOUD_ENDPOINT_RUNTIME_CONFIG);
            }
            return Response.json({ status: "ready" });
          },
        }),
      );
    },
  );

  it.effect("requests startup recovery for a legacy config without a recorded tunnel ID", () => {
    const { store } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"token"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const registration = yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773");
      expect(registration).toEqual({
        status: "recovery_required",
        config: { providerKind: "cloudflare_tunnel", connectorToken: "token" },
      });
      expect(
        managedTunnelStartupAction({
          wantsCliLink: false,
          registration,
        }),
      ).toEqual({
        action: "request_recovery",
        config: { providerKind: "cloudflare_tunnel", connectorToken: "token" },
      });
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(provideRecoveryHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("recovers a web-linked tunnel and clears its revoked mark", () => {
    const oldConfig =
      '{"providerKind":"cloudflare_tunnel","connectorToken":"old-token","tunnelId":"old-tunnel"}';
    const nextConfig = {
      providerKind: "cloudflare_tunnel",
      connectorToken: "new-token",
      tunnelId: "new-tunnel",
    } as const;
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, oldConfig],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
      [CLOUD_LINK_REVOKED, "true"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.recoverManagedTunnel("http://127.0.0.1:3773")).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe("https://relay.example.test/v1/environments/env_123/tunnel");
      expect(requests[0]?.headers.authorization).toBe("Bearer environment-credential");
      expect(applyConfigCalls).toEqual([nextConfig]);
      expect(
        Option.getOrNull(
          decodeRuntimeConfig(new TextDecoder().decode(values.get(CLOUD_ENDPOINT_RUNTIME_CONFIG))),
        ),
      ).toEqual(nextConfig);
      expect(values.has(CLOUD_LINK_REVOKED)).toBe(false);
    }).pipe(
      provideRecoveryHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () =>
          Response.json({
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: nextConfig,
          }),
      }),
    );
  });

  it.effect("marks the link revoked when the relay rejects a running host's recovery", () => {
    const { store, values } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"old-token","tunnelId":"old-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const error = yield* Effect.flip(link.recoverManagedTunnel("http://127.0.0.1:3773"));
      expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "unauthorized" });
      expect((yield* link.linkState()).linkRevoked).toBe(true);
      expect(applyConfigCalls).toEqual([]);
      expect(values.has(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBe(true);
    }).pipe(
      provideRecoveryHarness({
        store,
        applyConfigCalls,
        requests: [],
        respond: () =>
          Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "not_authorized",
              traceId: "trace-recovery-revoked",
            },
            { status: 401 },
          ),
      }),
    );
  });

  it.effect("allows managed tunnel provisioning to take longer than ten seconds", () =>
    Effect.gen(function* () {
      const oldConfig =
        '{"providerKind":"cloudflare_tunnel","connectorToken":"old-token","tunnelId":"old-tunnel"}';
      const nextConfig = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "new-token",
        tunnelId: "new-tunnel",
      };
      const { store } = makeMemorySecretStore([
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, oldConfig],
        [RELAY_URL_SECRET, "https://relay.example.test"],
        [CLOUD_LINKED_USER_ID, "user-123"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const requestStarted = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Response>();
      const recovery = yield* CloudLink.CloudLink.use((link) =>
        link.recoverManagedTunnel("http://127.0.0.1:3773"),
      ).pipe(
        provideRecoveryHarness({
          store,
          applyConfigCalls,
          requests,
          onRequest: () => Deferred.succeed(requestStarted, undefined),
          respondEffect: Deferred.await(response),
        }),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(requestStarted);
      expect(requests).toHaveLength(1);
      yield* TestClock.adjust("11 seconds");
      yield* Effect.yieldNow;
      yield* Deferred.succeed(
        response,
        Response.json({
          endpoint: {
            httpBaseUrl: "https://environment.example.test/",
            wsBaseUrl: "wss://environment.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          endpointRuntime: nextConfig,
        }),
      );

      expect(yield* Fiber.join(recovery)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(applyConfigCalls).toEqual([nextConfig]);
    }),
  );

  it.effect("does not recover an environment without a managed tunnel credential", () => {
    const { store } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "old-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.recoverManagedTunnel("http://127.0.0.1:3773")).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(provideRecoveryHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("ignores recovery requests for a tunnel that has already been replaced", () => {
    const { store } = makeMemorySecretStore([
      [
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        '{"providerKind":"cloudflare_tunnel","connectorToken":"current-token","tunnelId":"current-tunnel"}',
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(
        yield* link.recoverManagedTunnel("http://127.0.0.1:3773", {
          providerKind: "cloudflare_tunnel",
          connectorToken: "old-token",
          tunnelId: "old-tunnel",
        }),
      ).toBe(false);
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(provideRecoveryHarness({ store, applyConfigCalls, requests }));
  });

  it.effect.each([
    { status: 401, rejection: "unauthorized" },
    { status: 403, rejection: "forbidden" },
    { status: 409, rejection: "rejected" },
  ])("preserves a permanent $status relay recovery failure", ({ status, rejection }) => {
    const { store } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "old-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const error = yield* Effect.flip(link.recoverManagedTunnel("http://127.0.0.1:3773"));

      expect(error).toMatchObject({ _tag: "RelayRequestError", rejection });
      expect(CloudLink.shouldRetryCloudLink(error)).toBe(false);
      expect(requests).toHaveLength(1);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(
      provideRecoveryHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json({}, { status }),
      }),
    );
  });

  it.effect("keeps a tunnel configuration replaced during recovery", () => {
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "old-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const freshConfig = new TextEncoder().encode("fresh-config");

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(yield* link.recoverManagedTunnel("http://127.0.0.1:3773")).toBe(false);
      expect(values.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(freshConfig);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(
      provideRecoveryHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => {
          values.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, freshConfig);
          return Response.json({
            endpoint: {
              httpBaseUrl: "https://environment.example.test/",
              wsBaseUrl: "wss://environment.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: {
              providerKind: "cloudflare_tunnel",
              connectorToken: "replacement-token",
            },
          });
        },
      }),
    );
  });

  it.effect("does not report a managed tunnel after a relay config write fails part-way", () => {
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "managed-config"],
      [CLOUD_ENDPOINT_CONFIRMED_ORIGIN, "confirmed-origin"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "old-credential"],
    ]);
    const failingStore: ServerSecretStore.ServerSecretStore["Service"] = {
      ...store,
      set: (name, value) =>
        name === RELAY_ISSUER_SECRET
          ? Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: name,
                cause: PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: `${name}.bin`,
                }),
              }),
            )
          : store.set(name, value),
    };
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const cloudMintPublicKey =
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAMY09Vo5CzEA6aEkhB/0h27t4Qs71SHS1fTSI4K0KvZQ=\n-----END PUBLIC KEY-----\n";

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const error = yield* Effect.flip(
        link.applyRelayConfig({
          relayUrl: "https://relay.example.test",
          cloudUserId: "user-123",
          environmentCredential: "new-credential",
          cloudMintPublicKey,
          endpointRuntime: null,
        }),
      );

      expect(error._tag).toBe("CloudLinkInternalError");
      expect(yield* link.linkState()).toMatchObject({
        linked: true,
        cloudUserId: "user-123",
        managedTunnelActive: false,
      });
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideRecoveryHarness({ store: failingStore, applyConfigCalls, requests }));
  });
});
