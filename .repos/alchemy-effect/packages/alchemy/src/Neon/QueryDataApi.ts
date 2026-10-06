import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  backendEnvKey,
  backendString,
  bindBackendEnvironment,
} from "./BackendConnection.ts";
import type { DataApi } from "./DataApi.ts";

export class DataApiRequestError extends Data.TaggedError(
  "DataApiRequestError",
)<{ message: string }> {}

export interface QueryDataApiClient {
  /** Bound public PostgREST endpoint. */
  baseUrl: Effect.Effect<string, never, RuntimeContext>;
  /** Execute a relative PostgREST request with this caller's token, never an admin key. */
  execute: (
    request: HttpClientRequest.HttpClientRequest,
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError | DataApiRequestError,
    RuntimeContext | Scope.Scope
  >;
}

/**
 * Query Neon Data API (PostgREST) over HTTP from a Function, Worker, or Lambda
 * using an explicitly supplied caller token. Supports reads, writes and database
 * function calls; this binding does not provision database grants or RLS policies.
 *
 * This is a low-level Effect HTTP client, not a SQL driver or a fluent query
 * builder. Browser applications can use Neon's `@neondatabase/neon-js` or
 * `@neondatabase/postgrest-js` SDK directly with the public Data API URL.
 *
 * Relative URLs cannot redirect the authorization header to another origin.
 * Requests do not follow redirects, and response bodies remain request-scoped.
 *
 * ### Forward end-user authorization
 * **Example:** Query rows under the caller's RLS identity
 * ```typescript
 * const data = yield* Neon.QueryDataApi(dataApi);
 * // In the request handler, after obtaining the caller's token:
 * const response = yield* data.execute(HttpClientRequest.get("todos?select=*"), token);
 * ```
 *
 * @binding
 * @product Data API
 */
export interface QueryDataApi extends Binding.Service<
  QueryDataApi,
  "Neon.QueryDataApi",
  (dataApi: DataApi) => Effect.Effect<QueryDataApiClient>
> {}
export const QueryDataApi = Binding.Service<QueryDataApi>("Neon.QueryDataApi");

/** Data API transport, with the host and HTTP client encapsulated at initialization. */
export const QueryDataApiHttp = Layer.effect(
  QueryDataApi,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (dataApi: DataApi) {
      const key = backendEnvKey(dataApi.FQN, "DATA_API_URL");
      yield* bindBackendEnvironment(`Neon.QueryDataApi:${dataApi.FQN}`, {
        [key]: dataApi.url,
      });
      const baseUrl = backendString(key);
      return {
        baseUrl,
        execute: Effect.fn(function* (
          request: HttpClientRequest.HttpClientRequest,
          token: Redacted.Redacted<string>,
        ) {
          if (!Redacted.value(token))
            return yield* new DataApiRequestError({
              message: "An end-user token is required",
            });
          const base = (yield* baseUrl).replace(/\/$/, "") + "/";
          const target = yield* Effect.try({
            try: () => new URL(request.url.replace(/^\/(?!\/)/, ""), base),
            catch: () =>
              new DataApiRequestError({
                message: "Invalid relative Data API URL",
              }),
          });
          const origin = yield* Effect.sync(() => new URL(base));
          if (
            target.origin !== origin.origin ||
            !target.pathname.startsWith(origin.pathname) ||
            target.username ||
            target.password
          ) {
            return yield* new DataApiRequestError({
              message: "Data API request must stay within its bound endpoint",
            });
          }
          return yield* http
            .execute(
              request.pipe(
                HttpClientRequest.setUrl(target.href),
                HttpClientRequest.bearerToken(token),
              ),
            )
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "manual",
              }),
            );
        }),
      } satisfies QueryDataApiClient;
    });
  }),
);
