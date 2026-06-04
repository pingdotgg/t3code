import {
  AuthAccessTokenType,
  type AuthClientPresentationMetadata,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import type {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

const remoteEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
};

const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
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

export class RemoteEnvironmentAuthInvalidJsonError extends Data.TaggedError(
  "RemoteEnvironmentAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Data.TaggedError(
  "RemoteEnvironmentAuthUndeclaredStatusError",
)<{
  readonly message: string;
  readonly status: number;
  readonly requestUrl: string;
}> {
  constructor(requestUrl: string, status: number) {
    super({
      message: `Remote auth endpoint ${requestUrl} returned undeclared status ${status}.`,
      requestUrl,
      status,
    });
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
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentInternalError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const remoteHttpClientLayer = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)));

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentAuthError> => {
  if (cause instanceof RemoteEnvironmentAuthTimeoutError) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote auth endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, response.status),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote auth endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote auth endpoint ${requestUrl} (${String(cause)}).`,
      cause,
    }),
  );
};

const executeRemoteRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentAuthError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* HttpApiClient.makeWith(EnvironmentHttpApi, {
      httpClient,
      baseUrl: remoteApiBaseUrl(httpBaseUrl),
    });
  });

export const bootstrapRemoteBearerSession = Effect.fn(
  "clientRuntime.remote.bootstrapRemoteBearerSession",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeRemoteRequest(
    remoteEndpointUrl(input.httpBaseUrl, "/oauth/token"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.auth.token({
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: input.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        ...(input.scopes ? { scope: encodeOAuthScope(input.scopes) } : {}),
        ...(input.clientMetadata?.label ? { client_label: input.clientMetadata.label } : {}),
        ...(input.clientMetadata?.deviceType
          ? { client_device_type: input.clientMetadata.deviceType }
          : {}),
        ...(input.clientMetadata?.os ? { client_os: input.clientMetadata.os } : {}),
      },
    }),
  );
});

export const fetchRemoteSessionState = Effect.fn("clientRuntime.remote.fetchRemoteSessionState")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
    readonly timeoutMs?: number;
  }) {
    const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
    return yield* executeRemoteRequest(
      remoteEndpointUrl(input.httpBaseUrl, "/api/auth/session"),
      input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
      client.auth.session({
        headers: {
          authorization: `Bearer ${input.bearerToken}`,
        },
      }),
    );
  },
);

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.remote.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeRemoteRequest(
    remoteEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.metadata.descriptor(),
  );
});

export const issueRemoteWebSocketTicket = Effect.fn(
  "clientRuntime.remote.issueRemoteWebSocketTicket",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeRemoteRequest(
    remoteEndpointUrl(input.httpBaseUrl, "/api/auth/websocket-ticket"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.auth.webSocketTicket({
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
      },
    }),
  );
});

export const resolveRemoteWebSocketConnectionUrl = Effect.fn(
  "clientRuntime.remote.resolveRemoteWebSocketConnectionUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  const issued = yield* issueRemoteWebSocketTicket({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });

  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.set("wsTicket", issued.ticket);
  return url.toString();
});
