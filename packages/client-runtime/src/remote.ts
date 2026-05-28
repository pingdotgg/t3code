import {
  AuthSessionRole,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthRemoteSessionScope,
  AuthTokenExchangeGrantType,
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
  TrimmedNonEmptyString,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { oauthScopeSetEquals } from "@t3tools/shared/oauthScope";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { identity } from "effect/Function";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;
const RemoteAuthErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
});
const decodeRemoteAuthErrorBody = decodeJsonResult(RemoteAuthErrorBody);
const AuthBearerBootstrapJsonResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  role: AuthSessionRole,
  sessionMethod: Schema.Literal("bearer-session-token"),
  expiresAt: Schema.DateTimeUtcFromString,
  sessionToken: TrimmedNonEmptyString,
});
const AuthSessionJsonState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  role: Schema.optionalKey(AuthSessionRole),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
const AuthWebSocketTokenJsonResult = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtcFromString,
});
const AuthDpopAccessTokenJsonResult = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(AuthAccessTokenType),
  token_type: Schema.Literal("DPoP"),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: TrimmedNonEmptyString,
});

export const remoteEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export class RemoteEnvironmentAuthFetchError extends Data.TaggedError(
  "RemoteEnvironmentAuthFetchError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthResponseReadError extends Data.TaggedError(
  "RemoteEnvironmentAuthResponseReadError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthInvalidJsonError extends Data.TaggedError(
  "RemoteEnvironmentAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthHttpError extends Data.TaggedError(
  "RemoteEnvironmentAuthHttpError",
)<{
  readonly message: string;
  readonly status: number;
}> {
  constructor(message: string, status: number) {
    super({ message, status });
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Data.TaggedError(
  "RemoteEnvironmentAuthTimeoutError",
)<{
  readonly message: string;
  readonly requestUrl: string;
  readonly timeoutMs: number;
}> {
  constructor(requestUrl: string, timeoutMs: number) {
    super({
      message: `Remote auth endpoint ${requestUrl} timed out after ${timeoutMs}ms.`,
      requestUrl,
      timeoutMs,
    });
  }
}

export type RemoteEnvironmentAuthError =
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthResponseReadError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthHttpError
  | RemoteEnvironmentAuthTimeoutError;

export const isRemoteEnvironmentAuthHttpError = (
  error: unknown,
): error is RemoteEnvironmentAuthHttpError => error instanceof RemoteEnvironmentAuthHttpError;

const readRemoteAuthErrorMessage = (
  response: HttpClientResponse.HttpClientResponse,
  fallbackMessage: string,
): Effect.Effect<string, RemoteEnvironmentAuthResponseReadError> =>
  response.text.pipe(
    Effect.mapError(
      (cause) =>
        new RemoteEnvironmentAuthResponseReadError({
          message: "Remote auth endpoint returned an unreadable error response.",
          cause,
        }),
    ),
    Effect.map((text) => {
      if (!text) {
        return fallbackMessage;
      }

      const decoded = decodeRemoteAuthErrorBody(text);
      if (Result.isSuccess(decoded) && decoded.success.error) {
        return decoded.success.error;
      }

      return text;
    }),
  );

const readRemoteJson = <S extends Schema.Top>(input: {
  readonly response: HttpClientResponse.HttpClientResponse;
  readonly requestUrl: string;
  readonly schema: S;
}): Effect.Effect<S["Type"], RemoteEnvironmentAuthInvalidJsonError, S["DecodingServices"]> =>
  input.response.json.pipe(
    Effect.mapError(
      (cause) =>
        new RemoteEnvironmentAuthInvalidJsonError({
          message: `Remote auth endpoint returned invalid JSON from ${input.requestUrl}.`,
          cause,
        }),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(input.schema)),
    Effect.mapError(
      (cause) =>
        new RemoteEnvironmentAuthInvalidJsonError({
          message: `Remote auth endpoint returned an invalid response from ${input.requestUrl}.`,
          cause,
        }),
    ),
  );

export const remoteHttpClientLayer = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)));

const fetchRemoteJson = Effect.fn("clientRuntime.remote.fetchRemoteJson")(function* <
  S extends Schema.Top,
>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly schema: S;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly dpopAccessToken?: string;
  readonly dpopProof?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly formBody?: Record<string, string>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  const method = input.method ?? "GET";
  const timeoutMs = input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
  const request = HttpClientRequest.make(method)(requestUrl).pipe(
    input.bearerToken ? HttpClientRequest.bearerToken(input.bearerToken) : identity,
    input.dpopAccessToken
      ? HttpClientRequest.setHeader("authorization", `DPoP ${input.dpopAccessToken}`)
      : identity,
    input.dpopProof ? HttpClientRequest.setHeader("dpop", input.dpopProof) : identity,
    input.headers ? HttpClientRequest.setHeaders(input.headers) : identity,
    input.body !== undefined ? HttpClientRequest.bodyJsonUnsafe(input.body) : identity,
    input.formBody ? HttpClientRequest.bodyUrlParams(input.formBody) : identity,
  );

  const response = yield* HttpClient.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new RemoteEnvironmentAuthFetchError({
          message: `Failed to fetch remote auth endpoint ${requestUrl} (${String(cause)}).`,
          cause,
        }),
    ),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
  );

  if (response.status < 200 || response.status >= 300) {
    return yield* readRemoteAuthErrorMessage(
      response,
      `Remote auth request failed (${response.status}).`,
    ).pipe(
      Effect.flatMap((message) =>
        Effect.fail(new RemoteEnvironmentAuthHttpError(message, response.status)),
      ),
    );
  }

  return yield* readRemoteJson({
    response,
    requestUrl,
    schema: input.schema,
  });
});

export const exchangeRemoteDpopAccessToken = Effect.fn(
  "clientRuntime.remote.exchangeRemoteDpopAccessToken",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly dpopProof: string;
  readonly timeoutMs?: number;
}) {
  const response = yield* fetchRemoteJson({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/token",
    schema: AuthDpopAccessTokenJsonResult,
    method: "POST",
    dpopProof: input.dpopProof,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    formBody: {
      grant_type: AuthTokenExchangeGrantType,
      subject_token: input.credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      resource: new URL(input.httpBaseUrl).origin,
      scope: AuthRemoteSessionScope,
    },
  });
  if (!oauthScopeSetEquals(response.scope, [AuthRemoteSessionScope])) {
    return yield* new RemoteEnvironmentAuthInvalidJsonError({
      message: "Remote auth endpoint returned unexpected DPoP access token scopes.",
      cause: response.scope,
    });
  }
  return response;
});

export const bootstrapRemoteBearerSession = Effect.fn(
  "clientRuntime.remote.bootstrapRemoteBearerSession",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly proofKeyThumbprint?: string;
  readonly dpopProof?: string;
  readonly timeoutMs?: number;
}) {
  return yield* fetchRemoteJson({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/bootstrap/bearer",
    schema: AuthBearerBootstrapJsonResult,
    method: "POST",
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.dpopProof ? { headers: { dpop: input.dpopProof } } : {}),
    body: {
      credential: input.credential,
      ...(input.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
    },
  });
});

export const fetchRemoteSessionState = Effect.fn("clientRuntime.remote.fetchRemoteSessionState")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
    readonly timeoutMs?: number;
  }) {
    return yield* fetchRemoteJson({
      httpBaseUrl: input.httpBaseUrl,
      pathname: "/api/auth/session",
      schema: AuthSessionJsonState,
      bearerToken: input.bearerToken,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  },
);

export const fetchRemoteDpopSessionState = Effect.fn(
  "clientRuntime.remote.fetchRemoteDpopSessionState",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly dpopProof: string;
  readonly timeoutMs?: number;
}) {
  return yield* fetchRemoteJson({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/session",
    schema: AuthSessionJsonState,
    dpopAccessToken: input.accessToken,
    dpopProof: input.dpopProof,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
});

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.remote.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  return yield* fetchRemoteJson({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/.well-known/t3/environment",
    schema: ExecutionEnvironmentDescriptor,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
});

export const issueRemoteWebSocketToken = Effect.fn(
  "clientRuntime.remote.issueRemoteWebSocketToken",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  return yield* fetchRemoteJson({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/ws-token",
    schema: AuthWebSocketTokenJsonResult,
    method: "POST",
    bearerToken: input.bearerToken,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
});

export const issueRemoteDpopWebSocketToken = Effect.fn(
  "clientRuntime.remote.issueRemoteDpopWebSocketToken",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly dpopProof: string;
  readonly timeoutMs?: number;
}) {
  return yield* fetchRemoteJson({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/ws-token",
    schema: AuthWebSocketTokenJsonResult,
    method: "POST",
    dpopAccessToken: input.accessToken,
    dpopProof: input.dpopProof,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
});

export const resolveRemoteWebSocketConnectionUrl = Effect.fn(
  "clientRuntime.remote.resolveRemoteWebSocketConnectionUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  const issued = yield* issueRemoteWebSocketToken({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });

  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
});

export const resolveRemoteDpopWebSocketConnectionUrl = Effect.fn(
  "clientRuntime.remote.resolveRemoteDpopWebSocketConnectionUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly dpopProof: string;
  readonly timeoutMs?: number;
}) {
  const issued = yield* issueRemoteDpopWebSocketToken({
    httpBaseUrl: input.httpBaseUrl,
    accessToken: input.accessToken,
    dpopProof: input.dpopProof,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
});
