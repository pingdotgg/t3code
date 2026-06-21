import { EnvironmentHttpApi, EnvironmentHttpCommonError } from "@t3tools/contracts";
import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

const requestUrlDiagnosticSchema = {
  requestUrlInputLength: Schema.Number,
  requestUrlProtocol: Schema.optionalKey(Schema.String),
  requestUrlHostname: Schema.optionalKey(Schema.String),
} as const;

function requestUrlDiagnosticFields(requestUrl: string) {
  const diagnostics = getUrlDiagnostics(requestUrl);
  return {
    requestUrlInputLength: diagnostics.inputLength,
    ...(diagnostics.protocol === undefined ? {} : { requestUrlProtocol: diagnostics.protocol }),
    ...(diagnostics.hostname === undefined ? {} : { requestUrlHostname: diagnostics.hostname }),
  };
}

function requestUrlDescription(input: {
  readonly requestUrlInputLength: number;
  readonly requestUrlHostname?: string;
}): string {
  return input.requestUrlHostname === undefined
    ? `an invalid URL (${input.requestUrlInputLength} characters)`
    : `host ${input.requestUrlHostname} (${input.requestUrlInputLength} URL characters)`;
}

export class RemoteEnvironmentAuthFetchError extends Schema.TaggedErrorClass<RemoteEnvironmentAuthFetchError>()(
  "RemoteEnvironmentAuthFetchError",
  {
    ...requestUrlDiagnosticSchema,
    cause: Schema.Defect(),
  },
) {
  static fromRequestUrl(requestUrl: string, cause: unknown): RemoteEnvironmentAuthFetchError {
    return new RemoteEnvironmentAuthFetchError({
      ...requestUrlDiagnosticFields(requestUrl),
      cause,
    });
  }

  override get message(): string {
    return `Failed to fetch remote environment endpoint at ${requestUrlDescription(this)}.`;
  }
}

export class RemoteEnvironmentAuthInvalidJsonError extends Schema.TaggedErrorClass<RemoteEnvironmentAuthInvalidJsonError>()(
  "RemoteEnvironmentAuthInvalidJsonError",
  {
    ...requestUrlDiagnosticSchema,
    cause: Schema.Defect(),
  },
) {
  static fromRequestUrl(requestUrl: string, cause: unknown): RemoteEnvironmentAuthInvalidJsonError {
    return new RemoteEnvironmentAuthInvalidJsonError({
      ...requestUrlDiagnosticFields(requestUrl),
      cause,
    });
  }

  override get message(): string {
    return `Remote environment endpoint at ${requestUrlDescription(this)} returned an invalid response.`;
  }
}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Schema.TaggedErrorClass<RemoteEnvironmentAuthUndeclaredStatusError>()(
  "RemoteEnvironmentAuthUndeclaredStatusError",
  {
    ...requestUrlDiagnosticSchema,
    status: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  static fromRequestUrl(
    requestUrl: string,
    status: number,
    cause: unknown,
  ): RemoteEnvironmentAuthUndeclaredStatusError {
    return new RemoteEnvironmentAuthUndeclaredStatusError({
      ...requestUrlDiagnosticFields(requestUrl),
      status,
      cause,
    });
  }

  override get message(): string {
    return `Remote environment endpoint at ${requestUrlDescription(this)} returned undeclared status ${this.status}.`;
  }
}

export const isRemoteEnvironmentAuthUndeclaredStatusError = Schema.is(
  RemoteEnvironmentAuthUndeclaredStatusError,
);

export class RemoteEnvironmentAuthTimeoutError extends Schema.TaggedErrorClass<RemoteEnvironmentAuthTimeoutError>()(
  "RemoteEnvironmentAuthTimeoutError",
  {
    ...requestUrlDiagnosticSchema,
    timeoutMs: Schema.Number,
  },
) {
  static fromRequestUrl(requestUrl: string, timeoutMs: number): RemoteEnvironmentAuthTimeoutError {
    return new RemoteEnvironmentAuthTimeoutError({
      ...requestUrlDiagnosticFields(requestUrl),
      timeoutMs,
    });
  }

  override get message(): string {
    return `Remote environment endpoint at ${requestUrlDescription(this)} timed out after ${this.timeoutMs}ms.`;
  }
}

const isRemoteEnvironmentAuthTimeoutError = Schema.is(RemoteEnvironmentAuthTimeoutError);

export const RemoteEnvironmentRequestError = Schema.Union([
  EnvironmentHttpCommonError,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthInvalidJsonError,
  RemoteEnvironmentAuthUndeclaredStatusError,
  RemoteEnvironmentAuthTimeoutError,
]);
export type RemoteEnvironmentRequestError = typeof RemoteEnvironmentRequestError.Type;

export const remoteHttpClientLayer = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    httpHeaderRedactionLayer,
  );

const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (isRemoteEnvironmentAuthTimeoutError(cause)) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(RemoteEnvironmentAuthInvalidJsonError.fromRequestUrl(requestUrl, cause));
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        RemoteEnvironmentAuthUndeclaredStatusError.fromRequestUrl(
          requestUrl,
          response.status,
          cause,
        ),
      );
    }
    return Effect.fail(RemoteEnvironmentAuthInvalidJsonError.fromRequestUrl(requestUrl, cause));
  }
  return Effect.fail(RemoteEnvironmentAuthFetchError.fromRequestUrl(requestUrl, cause));
};

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(RemoteEnvironmentAuthTimeoutError.fromRequestUrl(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );
