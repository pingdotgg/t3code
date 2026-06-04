import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { StateApi } from "./HttpStateApi.ts";

import type { ReplacedResourceState, ResourceState } from "./ResourceState.ts";
import {
  StateStoreError,
  type PersistedState,
  type StateService,
} from "./State.ts";
import { encodeState, reviveStateRecursive } from "./StateEncoding.ts";

/**
 * Persisted shape of an HTTP state store endpoint — `{ url, authToken }`.
 * Stored in the credentials file alongside other per-profile secrets.
 * Deliberately separate from {@link HttpStateStoreProps}: `id` and
 * `transformClient` are deployment-time choices, not credentials.
 */
export interface HttpStateStoreCredentials {
  url: string;
  /** Bearer token used to authenticate every request. */
  authToken: string;
}

export interface HttpStateStoreProps extends HttpStateStoreCredentials {
  /**
   * `StateService.id` slug for telemetry — e.g. `"http"` for a bare
   * HTTP store, `"cloudflare-http"` for the Cloudflare-deployed
   * variant. Required so every concrete deployment of this state-store
   * shape shows up distinctly on the adoption dashboard.
   */
  id: string;
  transformClient?: (
    client: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest;
}

export const checkHttpStateStoreAuth = ({
  url,
  authToken,
}: {
  url: string;
  authToken: string;
}) =>
  Effect.gen(function* () {
    const apiClient = yield* HttpApiClient.make(StateApi, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest((req) =>
        req.pipe(HttpClientRequest.bearerToken(authToken)),
      ),
    });
    return yield* apiClient.state.listStacks().pipe(
      Effect.map(() => true),
      Effect.catchTag("Unauthorized", () => Effect.succeed(false)),
      Effect.retry({
        while: (error) =>
          error._tag === "HttpClientError" &&
          !!error.response &&
          // worker can 404 for a bit on first deploy
          (error.response.status === 404 || error.response.status >= 500),
        schedule: Schedule.fixed(200),
      }),
    );
  });

export const makeHttpStateStore = ({
  url,
  authToken,
  transformClient,
  id,
}: HttpStateStoreProps) =>
  Effect.gen(function* () {
    const apiClient = yield* HttpApiClient.make(StateApi, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest((req) =>
        req.pipe(
          HttpClientRequest.bearerToken(authToken),
          transformClient ?? identity,
        ),
      ),
    });
    const state = apiClient.state;

    const service: StateService = {
      id,
      getVersion: () =>
        apiClient.version.getVersion().pipe(
          Effect.map((v) => v.version),
          mapStateStoreError,
        ),
      listStacks: () =>
        state.listStacks().pipe(
          Effect.map((stacks) => [...stacks]),
          mapStateStoreError,
        ),
      listStages: (stack) =>
        state.listStages({ params: { stack } }).pipe(mapStateStoreError),
      list: (request) =>
        state.listResources({ params: request }).pipe(mapStateStoreError),
      get: (request) =>
        state
          .getState({
            params: {
              stack: request.stack,
              stage: request.stage,
              fqn: encodeURIComponent(request.fqn),
            },
          })
          .pipe(
            Effect.map((s) =>
              s == null
                ? undefined
                : (reviveStateRecursive(s) as ResourceState),
            ),
            mapStateStoreError,
          ),
      getReplacedResources: (request) =>
        state.getReplacedResources({ params: request }).pipe(
          Effect.map((resources) =>
            resources.map(
              (s) => reviveStateRecursive(s) as ReplacedResourceState,
            ),
          ),
          mapStateStoreError,
        ),
      set: <V extends PersistedState>(request: {
        stack: string;
        stage: string;
        fqn: string;
        value: V;
      }) =>
        state
          .setState({
            params: {
              stack: request.stack,
              stage: request.stage,
              fqn: encodeURIComponent(request.fqn),
            },
            payload: encodeState(request.value),
          })
          .pipe(
            // Server echoes the stored value, but the client already
            // has the canonical object (including any Redacted<T>
            // instances); returning the input avoids a lossy round-trip.
            Effect.map(() => request.value),
            mapStateStoreError,
          ),
      delete: (request) =>
        state
          .deleteState({
            params: {
              stack: request.stack,
              stage: request.stage,
              fqn: encodeURIComponent(request.fqn),
            },
          })
          .pipe(Effect.asVoid, mapStateStoreError),
      deleteStack: (request) =>
        state
          .deleteStack({
            params: { stack: request.stack },
            query: request.stage === undefined ? {} : { stage: request.stage },
          })
          .pipe(Effect.asVoid, mapStateStoreError),
      getOutput: (request) =>
        state
          .getStackOutput({
            params: { stack: request.stack, stage: request.stage },
          })
          .pipe(
            Effect.map((s) =>
              s == null ? undefined : reviveStateRecursive(s),
            ),
            mapStateStoreError,
          ),
      setOutput: (request) =>
        state
          .setStackOutput({
            params: { stack: request.stack, stage: request.stage },
            payload: encodeState(request.value as any),
          })
          .pipe(
            Effect.map(() => request.value),
            mapStateStoreError,
          ),
    };
    return service;
  });

/**
 * Predicate over an `HttpClientError`-shaped failure that returns `true`
 * for failures we expect to clear up on their own.
 *
 * We retry:
 * - all transport-level errors (no `response` — DNS, TCP reset, TLS,
 *   abort, etc.)
 * - 408 (request timeout) and 429 (rate limit)
 * - 404, which is normal in the seconds after a worker is first
 *   deployed and the route hasn't propagated yet
 * - every 5xx
 *
 * Anything else (400/401/403/etc.) is a real client-side problem and
 * shouldn't be hidden behind retries.
 */
const isTransient = (e: any): boolean => {
  if (e?._tag !== "HttpClientError") return false;
  const status: number | undefined = e.response?.status;
  if (status == null) return true;
  if (status === 404 || status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
};

const retryTransient = <A, Err, Req>(eff: Effect.Effect<A, Err, Req>) =>
  Effect.retry(eff, {
    while: isTransient,
    // Exponential backoff capped at 2s, max 5 attempts. Beyond that
    // the issue isn't transient and we'd rather surface a hard
    // failure than block the deploy indefinitely.
    schedule: Schedule.exponential(100).pipe(
      Schedule.either(Schedule.spaced("2 seconds")),
      Schedule.both(Schedule.recurs(5)),
    ),
  });

/** Collapse any client failure into a {@link StateStoreError}. */
const mapStateStoreError = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    retryTransient,
    Effect.tapError(Effect.log),
    Effect.catch((e: E) =>
      Effect.fail(
        new StateStoreError({
          message: e instanceof Error ? e.message : String(e),
          cause: e instanceof Error ? e : undefined,
        }),
      ),
    ),
  ) as Effect.Effect<A, StateStoreError, R>;
