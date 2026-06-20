import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { EnvironmentHttpInternalServerError } from "@t3tools/contracts";

import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import {
  CloudRelayRequestError,
  consumeCloudReplayGuards,
  reconcileDesiredCloudLink,
} from "./http.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "./traceRelayRequest.ts";

const encodeEnvironmentHttpInternalServerError = Schema.encodeUnknownSync(
  EnvironmentHttpInternalServerError,
);
const decodeEnvironmentHttpInternalServerError = Schema.decodeUnknownSync(
  EnvironmentHttpInternalServerError,
);

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new ServerSecretStore.SecretStorePersistError({
    operation: "create",
    secretName: "cloud replay guard",
    secretPath: "cloud-replay-guard.bin",
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
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: unusedSecretStoreOperation,
  };
}

function reconcileWith(input: {
  readonly getExisting: CliTokenManager.CloudCliTokenManager["Service"]["getExisting"];
  readonly httpClient?: HttpClient.HttpClient;
  readonly env?: Readonly<Record<string, string>>;
}) {
  return reconcileDesiredCloudLink("http://127.0.0.1:3774").pipe(
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
        getExisting: input.getExisting,
        hasCredential: unusedSecretStoreOperation(),
        clear: unusedSecretStoreOperation(),
      }),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      input.httpClient ?? HttpClient.make(() => unusedSecretStoreOperation()),
    ),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env ?? {} })),
      ),
    ),
  );
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

describe("CloudRelayRequestError", () => {
  it("classifies response failures without deriving its message from the cause", () => {
    const requestUrl =
      "https://relay-user:relay-password@relay.example.test/private/environment-links?token=relay-secret#relay-fragment";
    const request = HttpClientRequest.post(requestUrl);
    const response = HttpClientResponse.fromWeb(
      request,
      new Response("sensitive upstream response", { status: 502 }),
    );
    const upstreamCause = new Error("sensitive upstream response details");
    const cause = new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({
        request,
        response,
        cause: upstreamCause,
      }),
    });

    const error = CloudRelayRequestError.fromClientFailure({
      operation: "create-environment-link",
      url: request.url,
      cause,
    });

    expect(error).toMatchObject({
      operation: "create-environment-link",
      phase: "check-response-status",
      method: "POST",
      requestUrlInputLength: requestUrl.length,
      requestUrlProtocol: "https:",
      requestUrlHostname: "relay.example.test",
      responseStatus: 502,
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty("url");
    expect(error.message).toBe(
      "T3 Connect relay create-environment-link failed during check-response-status with response status 502.",
    );
    expect(error.message).not.toContain(upstreamCause.message);
    for (const secret of [
      "relay-user",
      "relay-password",
      "/private/environment-links",
      "relay-secret",
      "relay-fragment",
    ]) {
      expect(error.message).not.toContain(secret);
      expect(Object.values(error).join(" ")).not.toContain(secret);
    }
  });
});

it("preserves internal causes without encoding them into HTTP error bodies", () => {
  const cause = new Error("private upstream detail");
  const error = new EnvironmentHttpInternalServerError({
    message: "Stable public failure.",
    cause,
  });
  const encodeError = Schema.encodeUnknownSync(EnvironmentHttpInternalServerError);

  expect(error.cause).toBe(cause);
  expect(encodeError(error)).toEqual({
    _tag: "EnvironmentHttpInternalServerError",
    message: "Stable public failure.",
  });
});

it("keeps internal causes out of encoded HTTP error bodies", () => {
  const cause = new Error("private upstream detail");
  const error = new EnvironmentHttpInternalServerError({
    operation: "generate_link_proof",
    cause,
  });

  expect(error.cause).toBe(cause);
  expect(encodeEnvironmentHttpInternalServerError(error)).toEqual({
    _tag: "EnvironmentHttpInternalServerError",
    operation: "generate_link_proof",
    message: "Could not generate environment link proof.",
  });
});

it("decodes legacy message-only HTTP errors during rolling deployments", () => {
  const error = decodeEnvironmentHttpInternalServerError({
    _tag: "EnvironmentHttpInternalServerError",
    message: "Legacy environment server failure.",
  });

  expect(error.operation).toBeUndefined();
  expect(error.message).toBe("Legacy environment server failure.");
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
      const error = yield* Effect.flip(
        reconcileWith({ getExisting: Effect.succeed(Option.none()) }),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentHttpUnauthorizedError",
        reason: "cloud_cli_authorization_required",
        message: "Run `t3 connect link` to authorize this environment.",
      });
    }),
  );

  it.effect("redacts relay transport failures behind a stable structural message", () => {
    const transportCause = new Error("upstream included a sensitive database password");
    const capturedLogs: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make(({ message }) => {
      capturedLogs.push(Array.isArray(message) ? message : [message]);
    });
    const httpClient = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: transportCause }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        reconcileWith({
          getExisting: Effect.succeed(
            Option.some({
              accessToken: "access-token",
              refreshToken: "refresh-token",
              expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
            }),
          ),
          httpClient,
          env: { T3CODE_RELAY_URL: "https://relay.example.test" },
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentHttpInternalServerError",
        operation: "relay_request",
        relayOperation: "create-link-challenge",
        relayPhase: "send-request",
        message: "T3 Connect relay create-link-challenge failed during send-request.",
        cause: {
          _tag: "CloudRelayRequestError",
          operation: "create-link-challenge",
          phase: "send-request",
        },
      });
      expect(error.message).not.toContain(transportCause.message);
      expect(capturedLogs).toHaveLength(1);
      const logFields = capturedLogs[0]?.find(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      );
      expect(logFields).toMatchObject({ causeTag: "CloudRelayRequestError" });
      expect(logFields).not.toHaveProperty("cause");
      expect(capturedLogs[0]?.filter((value) => typeof value === "string").join(" ")).not.toContain(
        transportCause.message,
      );
    });
  });
});
