import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentAuthInvalidError,
  type EnvironmentConnectApprovalPendingError,
  type EnvironmentInternalError,
  type EnvironmentOperationForbiddenError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as HttpObservability from "@t3tools/shared/httpObservability";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class RemoteEnvironmentAuthFetchError extends Schema.TaggedError<RemoteEnvironmentAuthFetchError>()(
  "RemoteEnvironmentAuthFetchError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

class RemoteEnvironmentAuthInvalidJsonError extends Schema.TaggedError<RemoteEnvironmentAuthInvalidJsonError>()(
  "RemoteEnvironmentAuthInvalidJsonError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Schema.TaggedError<RemoteEnvironmentAuthUndeclaredStatusError>()(
  "RemoteEnvironmentAuthUndeclaredStatusError",
  {
    status: Schema.Number,
    requestUrl: Schema.String,
  },
) {
  override get message(): string {
    return `Remote environment endpoint ${this.requestUrl} returned undeclared status ${this.status}.`;
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Schema.TaggedError<RemoteEnvironmentAuthTimeoutError>()(
  "RemoteEnvironmentAuthTimeoutError",
  {
    requestUrl: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Remote environment endpoint ${this.requestUrl} timed out after ${this.timeoutMs}ms.`;
  }
}

const isRemoteEnvironmentAuthTimeoutError = Schema.is(RemoteEnvironmentAuthTimeoutError);

export type RemoteEnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError
  | EnvironmentConnectApprovalPendingError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const layerRemoteHttpClient = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    HttpObservability.layer,
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

export const makeEnvironmentHttpApiGroupClient = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
>(
  httpBaseUrl: string,
  group: Group,
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, {
      httpClient,
      group,
      baseUrl: remoteApiBaseUrl(httpBaseUrl),
    }),
  );

export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, {
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
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new RemoteEnvironmentAuthUndeclaredStatusError({ requestUrl, status: response.status }),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote environment endpoint ${requestUrl} (${String(cause)}).`,
      cause,
    }),
  );
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
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError({ requestUrl, timeoutMs })),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );
