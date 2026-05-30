import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
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

const remoteEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
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

const readRemoteJson = <T>(
  response: HttpClientResponse.HttpClientResponse,
  requestUrl: string,
): Effect.Effect<T, RemoteEnvironmentAuthInvalidJsonError> =>
  response.json.pipe(
    Effect.mapError(
      (cause) =>
        new RemoteEnvironmentAuthInvalidJsonError({
          message: `Remote auth endpoint returned invalid JSON from ${requestUrl}.`,
          cause,
        }),
    ),
    Effect.map((value) => value as T),
  );

export const remoteHttpClientLayer = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)));

const fetchRemoteJson = Effect.fn("clientRuntime.remote.fetchRemoteJson")(function* <T>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}) {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  const method = input.method ?? "GET";
  const timeoutMs = input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
  const request = HttpClientRequest.make(method)(requestUrl).pipe(
    input.bearerToken ? HttpClientRequest.bearerToken(input.bearerToken) : identity,
    input.body !== undefined ? HttpClientRequest.bodyJsonUnsafe(input.body) : identity,
  );

  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request).pipe(
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

  return yield* readRemoteJson<T>(response, requestUrl);
});

export const bootstrapRemoteBearerSession = Effect.fn(
  "clientRuntime.remote.bootstrapRemoteBearerSession",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly timeoutMs?: number;
}) {
  return yield* fetchRemoteJson<AuthBearerBootstrapResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/bootstrap/bearer",
    method: "POST",
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    body: {
      credential: input.credential,
    },
  });
});

export const fetchRemoteSessionState = Effect.fn("clientRuntime.remote.fetchRemoteSessionState")(
  function* (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
    readonly timeoutMs?: number;
  }) {
    return yield* fetchRemoteJson<AuthSessionState>({
      httpBaseUrl: input.httpBaseUrl,
      pathname: "/api/auth/session",
      bearerToken: input.bearerToken,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  },
);

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.remote.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  return yield* fetchRemoteJson<ExecutionEnvironmentDescriptor>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/.well-known/t3/environment",
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
  return yield* fetchRemoteJson<AuthWebSocketTokenResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/ws-token",
    method: "POST",
    bearerToken: input.bearerToken,
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
