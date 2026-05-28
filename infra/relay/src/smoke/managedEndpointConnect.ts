// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";

import {
  AuthAccessTokenType,
  AuthDpopAccessTokenResult,
  AuthEnvironmentBootstrapTokenType,
  AuthRemoteSessionScope,
  AuthTokenExchangeGrantType,
  ExecutionEnvironmentDescriptor,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import {
  createEnvironmentConnection,
  createKnownEnvironment,
  createWsRpcClient,
  resolveRemoteDpopWebSocketConnectionUrl,
  WsTransport,
} from "@t3tools/client-runtime";
import {
  RelayAccessTokenType,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayDpopTokenExchangeGrantType,
  RelayJwtSubjectTokenType,
  RelayMobileClientId,
  RelayDpopAccessTokenResponse,
  RelayEnvironmentConnectResponse,
  type RelayManagedEndpoint,
  RelayEnvironmentStatusResponse,
  RelayListEnvironmentsResponse,
} from "@t3tools/contracts/relay";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import { computeDpopJwkThumbprint, DpopPublicJwk } from "@t3tools/shared/dpop";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SchemaError } from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as NodeServices from "@effect/platform-node/NodeServices";

type HttpMethod = "GET" | "POST";

class SmokeConfigError extends Data.TaggedError("SmokeConfigError")<{
  readonly message: string;
}> {}

class SmokeRequestError extends Data.TaggedError("SmokeRequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class SmokeHttpError extends Data.TaggedError("SmokeHttpError")<{
  readonly message: string;
  readonly status: number;
  readonly body: string;
}> {}

class SmokeDecodeError extends Data.TaggedError("SmokeDecodeError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

interface DpopKeyPair {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

const decodeDpopPublicJwk = Schema.decodeUnknownSync(DpopPublicJwk);

function readRequiredEnv(name: string): Effect.Effect<string, SmokeConfigError> {
  return Effect.sync(() => process.env[name]?.trim() ?? "").pipe(
    Effect.flatMap((value) =>
      value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(
            new SmokeConfigError({ message: `Missing required environment variable ${name}.` }),
          ),
    ),
  );
}

function readClerkJwt(): Effect.Effect<string, SmokeConfigError> {
  return readRequiredEnv("CLERK_JWT").pipe(
    Effect.catchTag("SmokeConfigError", (error) =>
      Effect.fail(
        new SmokeConfigError({
          message: `${error.message} This smoke validates the Clerk-authenticated relay client flow; `,
        }),
      ),
    ),
  );
}

function readOptionalEnv(name: string): Effect.Effect<string | null> {
  return Effect.sync(() => {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : null;
  });
}

const makeDpopKeyPair = Effect.try({
  try: () => {
    const pair = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const publicJwk = decodeDpopPublicJwk(pair.publicKey.export({ format: "jwk" }));
    return {
      privateKey: pair.privateKey,
      publicJwk,
      thumbprint: computeDpopJwkThumbprint(publicJwk),
    } satisfies DpopKeyPair;
  },
  catch: (cause) =>
    new SmokeRequestError({
      message: "Could not generate DPoP key pair.",
      cause,
    }),
});

function base64UrlJson(value: unknown): string {
  return Encoding.encodeBase64Url(new TextEncoder().encode(stableStringify(value)));
}

function makeDpopProof(input: {
  readonly keyPair: DpopKeyPair;
  readonly method: HttpMethod;
  readonly url: string;
  readonly now: DateTime.DateTime;
  readonly accessToken?: string;
}): Effect.Effect<string, SmokeRequestError, Crypto.Crypto> {
  return Effect.gen(function* () {
    const jti = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.mapError(
        (cause) =>
          new SmokeRequestError({ message: "Could not generate DPoP proof identifier.", cause }),
      ),
    );
    const header = base64UrlJson({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: input.keyPair.publicJwk,
    });
    const ath = input.accessToken
      ? yield* Crypto.Crypto.pipe(
          Effect.flatMap((crypto) =>
            crypto.digest("SHA-256", new TextEncoder().encode(input.accessToken)),
          ),
          Effect.map(Encoding.encodeBase64Url),
          Effect.mapError(
            (cause) =>
              new SmokeRequestError({
                message: "Could not calculate DPoP access token hash.",
                cause,
              }),
          ),
        )
      : null;
    const payload = base64UrlJson({
      htm: input.method,
      htu: input.url,
      jti,
      iat: Math.floor(input.now.epochMilliseconds / 1_000),
      ...(ath ? { ath } : {}),
    });
    const signature = yield* Effect.try({
      try: () =>
        NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
          key: input.keyPair.privateKey,
          dsaEncoding: "ieee-p1363",
        }),
      catch: (cause) =>
        new SmokeRequestError({
          message: "Could not sign DPoP proof.",
          cause,
        }),
    });
    return `${header}.${payload}.${Encoding.encodeBase64Url(signature)}`;
  });
}

const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);
const MANAGED_ENDPOINT_WS_BOOTSTRAP_TIMEOUT_MS = 10_000;

function fetchText(input: {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Effect.Effect<
  string,
  SmokeRequestError | SmokeHttpError | SmokeDecodeError,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const body =
      typeof input.body === "string"
        ? input.body
        : input.body
          ? yield* encodeJson(input.body).pipe(
              Effect.mapError(
                (cause) =>
                  new SmokeDecodeError({
                    message: "Could not encode smoke request body.",
                    cause,
                  }),
              ),
            )
          : undefined;
    const request = HttpClientRequest.make(input.method)(input.url, {
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...input.headers,
      },
    }).pipe(
      body
        ? HttpClientRequest.bodyText(body, input.headers?.["content-type"] ?? "application/json")
        : (request) => request,
    );
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new SmokeRequestError({
            message: `${input.method} ${input.url} failed before a response was received.`,
            cause,
          }),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new SmokeRequestError({
            message: `${input.method} ${input.url} returned an unreadable response.`,
            cause,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new SmokeHttpError({
        message: `${input.method} ${input.url} failed with ${response.status}.`,
        status: response.status,
        body: text,
      });
    }
    return text;
  });
}

function fetchJson<S extends Schema.Top>(input: {
  readonly url: string;
  readonly method: HttpMethod;
  readonly schema: S;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Effect.Effect<
  Schema.Schema.Type<S>,
  SmokeRequestError | SmokeHttpError | SmokeDecodeError,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const text = yield* fetchText(input);
    const decode = Schema.decodeEffect(Schema.fromJsonString(input.schema)) as (
      value: string,
    ) => Effect.Effect<Schema.Schema.Type<S>, SchemaError>;
    const parsed = yield* decode(text).pipe(
      Effect.mapError(
        (cause) =>
          new SmokeDecodeError({
            message: `${input.method} ${input.url} returned invalid JSON.`,
            cause,
          }),
      ),
    );
    return parsed;
  });
}

function endpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(pathname, httpBaseUrl);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function verifyManagedEndpointWebSocket(input: {
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly connect: RelayEnvironmentConnectResponse;
  readonly accessToken: string;
  readonly keyPair: DpopKeyPair;
}): Effect.Effect<
  OrchestrationShellSnapshot,
  SmokeRequestError,
  Crypto.Crypto | HttpClient.HttpClient
> {
  return Effect.scoped(
    Effect.gen(function* () {
      let shellSnapshot: OrchestrationShellSnapshot | null = null;
      const wsTokenUrl = endpointUrl(input.connect.endpoint.httpBaseUrl, "/api/auth/ws-token");
      const proof = yield* makeDpopProof({
        keyPair: input.keyPair,
        method: "POST",
        url: wsTokenUrl,
        now: yield* DateTime.now,
        accessToken: input.accessToken,
      });
      const websocketUrl = yield* resolveRemoteDpopWebSocketConnectionUrl({
        httpBaseUrl: input.connect.endpoint.httpBaseUrl,
        wsBaseUrl: input.connect.endpoint.wsBaseUrl,
        accessToken: input.accessToken,
        dpopProof: proof,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SmokeRequestError({
              message: "Could not resolve managed endpoint WebSocket URL.",
              cause,
            }),
        ),
      );
      const transport = new WsTransport(() => Promise.resolve(websocketUrl));
      const client = createWsRpcClient(transport);
      const connection = createEnvironmentConnection({
        kind: "saved",
        knownEnvironment: {
          ...createKnownEnvironment({
            id: input.connect.environmentId,
            label: input.descriptor.label,
            source: "manual",
            target: {
              httpBaseUrl: input.connect.endpoint.httpBaseUrl,
              wsBaseUrl: input.connect.endpoint.wsBaseUrl,
            },
          }),
          environmentId: input.connect.environmentId,
        },
        client,
        applyShellEvent: () => undefined,
        syncShellSnapshot: (snapshot) => {
          shellSnapshot = snapshot;
        },
      });
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: () => connection.dispose(),
          catch: (cause) =>
            new SmokeRequestError({
              message: "Could not dispose managed endpoint WebSocket smoke connection.",
              cause,
            }),
        }).pipe(Effect.ignore),
      );

      const bootstrapped = yield* Effect.tryPromise({
        try: () => connection.ensureBootstrapped(),
        catch: (cause) =>
          new SmokeRequestError({
            message: "Managed endpoint WebSocket did not deliver a shell snapshot.",
            cause,
          }),
      }).pipe(Effect.timeoutOption(Duration.millis(MANAGED_ENDPOINT_WS_BOOTSTRAP_TIMEOUT_MS)));
      if (Option.isNone(bootstrapped)) {
        return yield* new SmokeRequestError({
          message: `Managed endpoint WebSocket did not bootstrap within ${MANAGED_ENDPOINT_WS_BOOTSTRAP_TIMEOUT_MS}ms.`,
        });
      }

      if (shellSnapshot === null) {
        return yield* new SmokeRequestError({
          message: "Managed endpoint WebSocket bootstrapped without a shell snapshot.",
        });
      }
      return shellSnapshot;
    }),
  );
}

export function endpointMatches(left: RelayManagedEndpoint, right: RelayManagedEndpoint): boolean {
  return (
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl &&
    left.providerKind === right.providerKind
  );
}

const managedEndpointConnectSmokeProgram = Effect.gen(function* () {
  const [relayUrl, environmentId, clerkJwt, deviceId, keyPair] = yield* Effect.all([
    readRequiredEnv("T3_RELAY_URL"),
    readRequiredEnv("T3_ENVIRONMENT_ID"),
    readClerkJwt(),
    readOptionalEnv("T3_AGENT_AWARENESS_DEVICE_ID"),
    makeDpopKeyPair,
  ]);
  const listUrl = endpointUrl(relayUrl, "/v1/environments");
  const connectUrl = endpointUrl(
    relayUrl,
    `/v1/environments/${encodeURIComponent(environmentId)}/connect`,
  );
  const statusUrl = endpointUrl(
    relayUrl,
    `/v1/environments/${encodeURIComponent(environmentId)}/status`,
  );
  const tokenUrl = endpointUrl(relayUrl, "/v1/client/dpop-token");
  const listed = yield* fetchJson({
    url: listUrl,
    method: "GET",
    schema: RelayListEnvironmentsResponse,
    headers: {
      authorization: `Bearer ${clerkJwt}`,
    },
  });
  const listedEnvironment = listed.environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  if (!listedEnvironment) {
    return yield* new SmokeHttpError({
      message: "Relay did not advertise the requested environment to this Clerk user.",
      status: 404,
      body: `Expected ${environmentId}; relay listed ${listed.environments.length} environment(s).`,
    });
  }
  const now = yield* DateTime.now;
  const tokenDpop = yield* makeDpopProof({
    keyPair,
    method: "POST",
    url: tokenUrl,
    now,
  });
  const relayToken = yield* fetchJson({
    url: tokenUrl,
    method: "POST",
    schema: RelayDpopAccessTokenResponse,
    headers: {
      dpop: tokenDpop,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: RelayDpopTokenExchangeGrantType,
      subject_token: clerkJwt,
      subject_token_type: RelayJwtSubjectTokenType,
      requested_token_type: RelayAccessTokenType,
      resource: relayUrl.replace(/\/+$/, ""),
      scope: encodeOAuthScope([RelayEnvironmentConnectScope, RelayEnvironmentStatusScope]),
      client_id: RelayMobileClientId,
    }).toString(),
  });
  const statusDpop = yield* makeDpopProof({
    keyPair,
    method: "POST",
    url: statusUrl,
    now,
    accessToken: relayToken.access_token,
  });
  const status = yield* fetchJson({
    url: statusUrl,
    method: "POST",
    schema: RelayEnvironmentStatusResponse,
    headers: {
      authorization: `DPoP ${relayToken.access_token}`,
      dpop: statusDpop,
    },
  });
  if (
    status.environmentId !== listedEnvironment.environmentId ||
    !endpointMatches(status.endpoint, listedEnvironment.endpoint)
  ) {
    return yield* new SmokeHttpError({
      message: "Managed endpoint status response did not match the advertised environment record.",
      status: 502,
      body: stableStringify({
        listedEnvironment,
        statusEnvironmentId: status.environmentId,
        statusEndpoint: status.endpoint,
      }),
    });
  }
  if (status.status !== "online") {
    return yield* new SmokeHttpError({
      message: `Managed endpoint status check returned ${status.status}.`,
      status: 503,
      body: status.error ?? "Environment did not report online status.",
    });
  }

  const connectDpop = yield* makeDpopProof({
    keyPair,
    method: "POST",
    url: connectUrl,
    now,
    accessToken: relayToken.access_token,
  });
  const connect = yield* fetchJson({
    url: connectUrl,
    method: "POST",
    schema: RelayEnvironmentConnectResponse,
    headers: {
      authorization: `DPoP ${relayToken.access_token}`,
      dpop: connectDpop,
    },
    body: {
      clientKeyThumbprint: keyPair.thumbprint,
      ...(deviceId ? { deviceId } : {}),
    },
  });
  if (
    connect.environmentId !== listedEnvironment.environmentId ||
    !endpointMatches(connect.endpoint, listedEnvironment.endpoint)
  ) {
    return yield* new SmokeHttpError({
      message: "Managed endpoint connect response did not match the advertised environment record.",
      status: 502,
      body: stableStringify({
        listedEnvironment,
        connectEnvironmentId: connect.environmentId,
        connectEndpoint: connect.endpoint,
      }),
    });
  }

  const descriptor = yield* fetchJson({
    url: endpointUrl(connect.endpoint.httpBaseUrl, "/.well-known/t3/environment"),
    method: "GET",
    schema: ExecutionEnvironmentDescriptor,
  });
  if (descriptor.environmentId !== connect.environmentId) {
    return yield* new SmokeHttpError({
      message: "Managed endpoint descriptor did not match the connected environment.",
      status: 502,
      body: stableStringify({
        connectEnvironmentId: connect.environmentId,
        descriptorEnvironmentId: descriptor.environmentId,
      }),
    });
  }
  const bootstrapUrl = endpointUrl(connect.endpoint.httpBaseUrl, "/api/auth/token");
  const bootstrapDpop = yield* makeDpopProof({
    keyPair,
    method: "POST",
    url: bootstrapUrl,
    now: yield* DateTime.now,
  });
  const bootstrap = yield* fetchJson({
    url: bootstrapUrl,
    method: "POST",
    schema: AuthDpopAccessTokenResult,
    headers: {
      dpop: bootstrapDpop,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: connect.credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      resource: new URL(connect.endpoint.httpBaseUrl).origin,
      scope: AuthRemoteSessionScope,
    }).toString(),
  });
  const shellSnapshot = yield* verifyManagedEndpointWebSocket({
    descriptor,
    connect,
    accessToken: bootstrap.access_token,
    keyPair,
  });

  yield* Console.log("Managed endpoint smoke passed", {
    environmentId: connect.environmentId,
    listedEnvironmentLabel: listedEnvironment.label,
    status: status.status,
    descriptorLabel: descriptor.label,
    endpointProviderKind: connect.endpoint.providerKind,
    httpBaseUrl: connect.endpoint.httpBaseUrl,
    wsBaseUrl: connect.endpoint.wsBaseUrl,
    tokenType: bootstrap.token_type,
    shellProjectCount: shellSnapshot.projects.length,
    shellThreadCount: shellSnapshot.threads.length,
  });
});

export const managedEndpointConnectSmoke = managedEndpointConnectSmokeProgram.pipe(
  Effect.provide(NodeServices.layer),
);

if (import.meta.main) {
  Effect.runPromise(
    managedEndpointConnectSmoke.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.catch((error) =>
        Console.error("Managed endpoint smoke failed", error).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    ),
  );
}
