// @ts-nocheck
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { TestClock } from "effect/testing";
import { HttpClient, HttpServerRequest } from "effect/unstable/http";

import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CliState from "./CliState.ts";
import {
  applyCloudRelayConfig,
  consumeCloudReplayGuards,
  persistCloudRelayConfig,
  reconcileDesiredCloudLink,
  relayClientRequest,
  unlinkCloudRuntime,
} from "./http.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "./traceRelayRequest.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

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

function makeSecretStore(
  create: ServerSecretStore.ServerSecretStore["Service"]["create"],
  options?: {
    readonly get?: ServerSecretStore.ServerSecretStore["Service"]["get"];
    readonly remove?: ServerSecretStore.ServerSecretStore["Service"]["remove"];
    readonly list?: ServerSecretStore.ServerSecretStore["Service"]["list"];
  },
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: options?.get ?? unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: options?.remove ?? unusedSecretStoreOperation,
    list: options?.list ?? (() => Effect.succeed([])),
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

  it.effect("removes invalid replay guard files before consuming new guards", () =>
    Effect.gen(function* () {
      const removed: string[] = [];
      const consumed = yield* consumeCloudReplayGuards({
        secrets: makeSecretStore(() => Effect.void, {
          list: () =>
            Effect.succeed([
              "cloud-health-jti-invalid",
              "cloud-mint-nonce-current",
              "relay-credential",
            ]),
          get: (name) =>
            Effect.succeed(
              Option.some(
                new TextEncoder().encode(
                  name.endsWith("invalid") ? "invalid-date" : new Date().toISOString(),
                ),
              ),
            ),
          remove: (name) =>
            Effect.sync(() => {
              removed.push(name);
            }),
        }),
        names: ["cloud-jti", "cloud-nonce"],
        value: new TextEncoder().encode(new Date().toISOString()),
      });

      expect(consumed).toBe(true);
      expect(removed).toEqual(["cloud-health-jti-invalid"]);
    }),
  );

  it.effect("rolls back partially claimed guards when another guard is already consumed", () =>
    Effect.gen(function* () {
      const removed: string[] = [];
      const consumed = yield* consumeCloudReplayGuards({
        secrets: makeSecretStore(
          (name) =>
            name === "cloud-jti" ? Effect.void : Effect.fail(storeFailure("AlreadyExists")),
          {
            remove: (name) =>
              Effect.sync(() => {
                removed.push(name);
              }),
          },
        ),
        names: ["cloud-jti", "cloud-nonce"],
        value: new Uint8Array(),
      });

      expect(consumed).toBe(false);
      expect(removed).toEqual(["cloud-jti"]);
    }),
  );
});

describe("relay request tracing", () => {
  it.effect("does not accept an unauthenticated request trace parent", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.Span> = [];
      const productTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://environment.example.test/api/t3-cloud/mint-credential", {
          headers: {
            traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          },
        }),
      );

      yield* traceRelayRequest(Effect.void.pipe(Effect.withSpan("relay.mint.handler"))).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
      );

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.traceId).not.toBe("0123456789abcdef0123456789abcdef");
      expect(Option.isNone(span.parent)).toBe(true);
    }),
  );

  it.effect("continues an authenticated relay trace with the product tracer", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.Span> = [];
      const productTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("https://environment.example.test/api/t3-cloud/mint-credential", {
          headers: {
            traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          },
        }),
      );

      yield* traceAuthenticatedRelayRequest(
        Effect.void.pipe(Effect.withSpan("relay.mint.handler")),
      ).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(RelayClientTracer, Option.some(productTracer)),
      );

      expect(spans).toHaveLength(1);
      const span = spans[0]!;
      expect(span.traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(Option.getOrUndefined(span.parent)?.spanId).toBe("0123456789abcdef");
    }),
  );
});

describe("reconcileDesiredCloudLink", () => {
  it.effect("requires stored CLI authorization without exposing an HTTP endpoint", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(reconcileDesiredCloudLink("http://127.0.0.1:3774"));

      expect(error).toMatchObject({
        _tag: "EnvironmentHttpUnauthorizedError",
        message: "Run `t3 connect link` to authorize this environment.",
      });
    }).pipe(
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
          getExisting: Effect.succeed(Option.none()),
          hasCredential: unusedSecretStoreOperation(),
          clear: unusedSecretStoreOperation(),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => unusedSecretStoreOperation()),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
});

it.effect("rolls back incomplete relay configuration writes before exposing a linked user", () =>
  Effect.gen(function* () {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const values = new Map<string, Uint8Array>([
      [RELAY_URL_SECRET, encoder.encode("https://old-relay.example.test")],
      [CLOUD_LINKED_USER_ID, encoder.encode("old-user")],
    ]);
    let failCredentialWrite = true;
    const secrets = {
      get: (name: string) =>
        Effect.sync(() => {
          const value = values.get(name);
          return value === undefined ? Option.none<Uint8Array>() : Option.some(value);
        }),
      set: (name: string, value: Uint8Array) =>
        Effect.suspend(() => {
          if (name === RELAY_ENVIRONMENT_CREDENTIAL_SECRET && failCredentialWrite) {
            failCredentialWrite = false;
            return Effect.fail(new Error("disk unavailable"));
          }
          return Effect.sync(() => {
            values.set(name, value);
          });
        }),
      remove: (name: string) =>
        Effect.sync(() => {
          values.delete(name);
        }),
    } as ServerSecretStore.ServerSecretStore["Service"];

    yield* Effect.flip(
      persistCloudRelayConfig(secrets, {
        relayUrl: "https://relay.example.test",
        relayIssuer: "https://relay.example.test",
        cloudUserId: "new-user",
        environmentCredential: "environment-credential",
        cloudMintPublicKey: "public-key",
        endpointRuntimeJson: null,
      }),
    );

    expect(decoder.decode(values.get(RELAY_URL_SECRET))).toBe("https://old-relay.example.test");
    expect(decoder.decode(values.get(CLOUD_LINKED_USER_ID))).toBe("old-user");
    expect(values.has(RELAY_ISSUER_SECRET)).toBe(false);
    expect(values.has(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)).toBe(false);
    expect(values.has(CLOUD_MINT_PUBLIC_KEY)).toBe(false);
  }),
);

it.effect("serializes relay configuration rollback with overlapping writes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const decoder = new TextDecoder();
      const values = new Map<string, Uint8Array>();
      const firstWriteStarted = yield* Deferred.make<void>();
      const releaseFirstWrite = yield* Deferred.make<void>();
      let failedFirstCredential = false;
      const secrets = {
        get: (name: string) =>
          Effect.sync(() => {
            const value = values.get(name);
            return value === undefined ? Option.none<Uint8Array>() : Option.some(value);
          }),
        set: (name: string, value: Uint8Array) =>
          Effect.gen(function* () {
            const decoded = decoder.decode(value);
            if (name === RELAY_URL_SECRET && decoded === "https://first.example.test") {
              yield* Deferred.succeed(firstWriteStarted, void 0);
              yield* Deferred.await(releaseFirstWrite);
            }
            if (
              name === RELAY_ENVIRONMENT_CREDENTIAL_SECRET &&
              decoded === "first-credential" &&
              !failedFirstCredential
            ) {
              failedFirstCredential = true;
              return yield* Effect.fail(new Error("first write failed"));
            }
            values.set(name, value);
          }),
        remove: (name: string) =>
          Effect.sync(() => {
            values.delete(name);
          }),
      } as ServerSecretStore.ServerSecretStore["Service"];

      const first = yield* Effect.result(
        persistCloudRelayConfig(secrets, {
          relayUrl: "https://first.example.test",
          relayIssuer: "https://first.example.test",
          cloudUserId: "first-user",
          environmentCredential: "first-credential",
          cloudMintPublicKey: "first-key",
          endpointRuntimeJson: null,
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(firstWriteStarted);
      const second = yield* persistCloudRelayConfig(secrets, {
        relayUrl: "https://second.example.test",
        relayIssuer: "https://second.example.test",
        cloudUserId: "second-user",
        environmentCredential: "second-credential",
        cloudMintPublicKey: "second-key",
        endpointRuntimeJson: null,
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFirstWrite, void 0);

      expect((yield* Fiber.join(first))._tag).toBe("Failure");
      yield* Fiber.join(second);
      expect(decoder.decode(values.get(RELAY_URL_SECRET))).toBe("https://second.example.test");
      expect(decoder.decode(values.get(CLOUD_LINKED_USER_ID))).toBe("second-user");
      expect(decoder.decode(values.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET))).toBe(
        "second-credential",
      );
    }),
  ),
);

it.effect("stops a newly started tunnel when unlink disables Connect during runtime startup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>();
      const runtimeStartupStarted = yield* Deferred.make<void>();
      const releaseRuntimeStartup = yield* Deferred.make<void>();
      const runtimeConfigs: Array<RelayManagedEndpointRuntimeConfig | null> = [];
      const publicKey = NodeCrypto.generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString();
      const secrets = {
        get: (name: string) =>
          Effect.sync(() => {
            const value = values.get(name);
            return value === undefined ? Option.none<Uint8Array>() : Option.some(value);
          }),
        set: (name: string, value: Uint8Array) =>
          Effect.sync(() => {
            values.set(name, value);
          }),
        create: unusedSecretStoreOperation,
        getOrCreateRandom: unusedSecretStoreOperation,
        remove: (name: string) =>
          Effect.sync(() => {
            values.delete(name);
          }),
        list: () => Effect.succeed([]),
      } as ServerSecretStore.ServerSecretStore["Service"];

      yield* CliState.setCliDesiredCloudLink(true).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      );
      const applying = yield* Effect.result(
        applyCloudRelayConfig(
          {
            secrets,
            endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
              applyConfig: (config) =>
                Effect.gen(function* () {
                  runtimeConfigs.push(config);
                  if (config === null) return { status: "disabled" as const };
                  yield* Deferred.succeed(runtimeStartupStarted, undefined);
                  yield* Deferred.await(releaseRuntimeStartup);
                  return {
                    status: "starting" as const,
                    providerKind: "cloudflare_tunnel" as const,
                    pid: 123,
                  };
                }),
              getStatus: Effect.succeed({ status: "disabled" }),
            }),
          } as never,
          {
            relayUrl: "https://relay.example.test",
            cloudUserId: "cloud-user",
            environmentCredential: "credential",
            cloudMintPublicKey: publicKey,
            endpointRuntime: {
              providerKind: "cloudflare_tunnel",
              connectorToken: "connector-token",
            },
          },
        ),
      ).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.forkScoped,
      );

      yield* Deferred.await(runtimeStartupStarted);
      yield* CliState.setCliDesiredCloudLink(false).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      );
      yield* Deferred.succeed(releaseRuntimeStartup, undefined);

      const exit = yield* Fiber.join(applying);
      expect(exit).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "EnvironmentHttpConflictError",
        },
      });
      expect(runtimeConfigs).toEqual([
        {
          providerKind: "cloudflare_tunnel",
          connectorToken: "connector-token",
        },
        null,
      ]);
    }),
  ),
);

it.effect("reports a failed stop when Connect is disabled before runtime apply", () =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>();
    const runtimeConfigs: Array<RelayManagedEndpointRuntimeConfig | null> = [];
    const publicKey = NodeCrypto.generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    const secrets = {
      get: (name: string) =>
        Effect.sync(() => {
          const value = values.get(name);
          return value === undefined ? Option.none<Uint8Array>() : Option.some(value);
        }),
      set: (name: string, value: Uint8Array) =>
        Effect.sync(() => {
          values.set(name, value);
          if (name === CLOUD_MINT_PUBLIC_KEY) {
            values.delete(CliState.CLOUD_CLI_DESIRED_LINK_SECRET);
          }
        }),
      create: unusedSecretStoreOperation,
      getOrCreateRandom: unusedSecretStoreOperation,
      remove: (name: string) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      list: () => Effect.succeed([]),
    } as ServerSecretStore.ServerSecretStore["Service"];

    yield* CliState.setCliDesiredCloudLink(true).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    const failure = yield* Effect.flip(
      applyCloudRelayConfig(
        {
          secrets,
          endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
            applyConfig: (config) =>
              Effect.sync(() => {
                runtimeConfigs.push(config);
                return {
                  status: "failed" as const,
                  providerKind: "cloudflare_tunnel" as const,
                  reason: "The relay client could not be stopped.",
                };
              }),
            getStatus: Effect.succeed({ status: "disabled" }),
          }),
        } as never,
        {
          relayUrl: "https://relay.example.test",
          cloudUserId: "cloud-user",
          environmentCredential: "credential",
          cloudMintPublicKey: publicKey,
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
          },
        },
      ).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secrets)),
    );

    expect(failure).toMatchObject({
      _tag: "EnvironmentCloudEndpointUnavailableError",
      endpointRuntimeStatus: { status: "failed" },
    });
    expect(runtimeConfigs).toEqual([null]);
  }),
);

it.effect("reports failed live tunnel teardown while keeping Connect durably disabled", () =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>();
    const runtimeConfigs: Array<RelayManagedEndpointRuntimeConfig | null> = [];
    const secrets = {
      get: (name: string) =>
        Effect.sync(() => {
          const value = values.get(name);
          return value === undefined ? Option.none<Uint8Array>() : Option.some(value);
        }),
      set: (name: string, value: Uint8Array) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: unusedSecretStoreOperation,
      getOrCreateRandom: unusedSecretStoreOperation,
      remove: (name: string) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      list: () => Effect.succeed([]),
    } as ServerSecretStore.ServerSecretStore["Service"];
    yield* CliState.setCliDesiredCloudLink(true).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );

    const failure = yield* Effect.flip(
      unlinkCloudRuntime({
        secrets,
        endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
          applyConfig: (config) =>
            Effect.sync(() => {
              runtimeConfigs.push(config);
              return {
                status: "failed" as const,
                providerKind: "cloudflare_tunnel" as const,
                reason: "The relay client could not be stopped.",
              };
            }),
          getStatus: Effect.succeed({ status: "disabled" }),
        }),
      } as never).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, secrets)),
    );

    expect(failure).toMatchObject({
      _tag: "EnvironmentCloudEndpointUnavailableError",
      endpointRuntimeStatus: {
        status: "failed",
      },
    });
    expect(
      yield* CliState.readCliDesiredCloudLink.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      ),
    ).toBe(false);
    expect(runtimeConfigs).toEqual([null]);
  }),
);

it.effect("times out stalled relay requests after fifteen seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const result = yield* Effect.result(
        relayClientRequest({ httpClient: HttpClient.make(() => Effect.never) } as never, {
          url: "https://relay.example.test/v1/client/environment-links",
          token: "access-token",
          payload: {},
          schema: Schema.Unknown,
        }),
      ).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("15 seconds");
      const exit = yield* Fiber.join(result);
      expect(exit).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "EnvironmentHttpInternalServerError",
        },
      });
    }),
  ).pipe(
    Effect.provideService(RelayClientTracer, Option.none()),
    Effect.provide(TestClock.layer()),
  ),
);
