import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer, type HttpClientRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { EnvironmentId } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfigModule from "../config.ts";
import { writeServiceState } from "../serviceLauncher.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  type ServiceUpdateRecord,
} from "./serviceProtocol.ts";
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
  decodeRuntimeConfig,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import { consumeCloudReplayGuards } from "./CloudLink.ts";
import { pendingServiceUpdateExists } from "./updateHandoff.ts";
import { managedTunnelStartupAction } from "./managedTunnelStartup.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

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




describe("releaseManagedTunnelOnShutdown", () => {
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

  interface ReleaseHarness {
    readonly store: ServerSecretStore.ServerSecretStore["Service"];
    readonly applyConfigCalls: Array<unknown>;
    readonly requests: Array<HttpClientRequest.HttpClientRequest>;
    readonly onRequest?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>;
    readonly respond?: () => Response;
    readonly address?: HttpServer.HttpServer["Service"]["address"];
    readonly respondEffect?: Effect.Effect<Response>;
    readonly getExisting?: CliTokenManager.CloudCliTokenManager["Service"]["getExisting"];
    readonly latestReachability?: ConnectReachability.ConnectReachability["Service"]["latest"];
  }

  const writeLauncherState = (update: ServiceUpdateRecord) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfigModule.ServerConfig;
      const statePath = path.join(config.baseDir, "runtime", SERVICE_STATE_FILE);
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "0.0.30",
          update,
        }),
      );
    });

  const provideReleaseHarness =
    (harness: ReleaseHarness) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(CloudLink.layer.pipe(Layer.provide(ManagedPolicy.layerTest()))),
        Effect.provideService(
          ConnectReachability.ConnectReachability,
          ConnectReachability.ConnectReachability.of({
            check: Effect.die("unused"),
            latest: harness.latestReachability ?? Effect.succeedNone,
          }),
        ),
        Effect.provideService(HttpServer.HttpServer, {
          ...idleHttpServer,
          address: harness.address ?? idleHttpServer.address,
        }),
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
            inspectConnector: Effect.succeed(null),
            readinessChanged: Stream.empty,
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
            getExisting: harness.getExisting ?? Effect.succeedSome(cliToken),
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

        Effect.provide(
          ServerConfigModule.layerTest("/", { prefix: "t3-http-release-test-" }).pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
        Effect.scoped,
      );

  const managedLinkSecrets = [
    [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
    [CLOUD_ENDPOINT_CONFIRMED_ORIGIN, "confirmed-origin"],
    [RELAY_URL_SECRET, "https://relay.example.test"],
    [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
  ] as const;

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
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
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
      }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
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
        provideReleaseHarness({
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
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
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
      provideReleaseHarness({
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
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
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
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });
  it.effect.each([
    {
      status: 401,
      body: {
        _tag: "RelayAuthInvalidError",
        code: "auth_invalid",
        reason: "invalid_bearer",
        traceId: "trace-revoked",
      },
      rejection: "unauthorized",
    },
    { status: 403, body: {}, rejection: "forbidden" },
    { status: 409, body: {}, rejection: "rejected" },
  ])("preserves a permanent $status relay recovery failure", ({ status, body, rejection }) => {
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
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json(body, { status }),
      }),
    );
  });
  it.effect("retries a relay link proof rejected as expired", () => {
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

      expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "unavailable" });
      expect(error.message).toContain("Trace ID: trace-expired");
      expect(CloudLink.shouldRetryCloudLink(error)).toBe(true);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () =>
          Response.json(
            {
              _tag: "RelayEnvironmentLinkProofExpiredError",
              code: "environment_link_proof_expired",
              traceId: "trace-expired",
            },
            { status: 401 },
          ),
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
      provideReleaseHarness({
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
    }).pipe(provideReleaseHarness({ store: failingStore, applyConfigCalls, requests }));
  });
});

