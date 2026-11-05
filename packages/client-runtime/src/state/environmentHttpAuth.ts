import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { FetchHttpClient, type HttpMethod } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection, PreparedHttpAuthorization } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthTimeoutError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
  readonly dpop?: string;
}

export function withOrchestrationProtocolHeader(
  headers: EnvironmentHttpAuthHeaders,
): EnvironmentHttpAuthHeaders & {
  readonly [ORCHESTRATION_PROTOCOL_HEADER]: typeof ORCHESTRATION_PROTOCOL_VERSION_TEXT;
} {
  return {
    ...headers,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  };
}

/**
 * Cookie-authenticated environments need credentialed mode for cross-origin fetches; bearer/DPoP uses headers.
 * `FetchHttpClient` reads `RequestInit` from the fiber context per request.
 */
const withEnvironmentCredentials = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization === null
    ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : request;

const buildEnvironmentAuthHeaders = Effect.fn("environmentHttpAuth.buildEnvironmentAuthHeaders")(
  function* (
    authorization: PreparedHttpAuthorization | null,
    method: HttpMethod.HttpMethod,
    url: string,
    signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>,
  ): Effect.fn.Return<EnvironmentHttpAuthHeaders, RemoteEnvironmentAuthFetchError> {
    if (authorization === null) {
      return {};
    }
    if (authorization._tag === "Bearer") {
      return { authorization: `Bearer ${authorization.token}` };
    }
    if (Option.isNone(signer)) {
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "No DPoP signer is available to authorize the environment request.",
        cause: authorization._tag,
      });
    }
    const proof = yield* signer.value
      .createProof({ method, url, accessToken: authorization.accessToken })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoteEnvironmentAuthFetchError({
              message: "Could not create the environment request authorization proof.",
              cause,
            }),
        ),
      );
    return { authorization: `DPoP ${authorization.accessToken}`, dpop: proof };
  },
);

/**
 * A DPoP request is T3 Connect work, so its span starts an exported trace that
 * the environment continues; its local caller's span would leave that trace
 * without a root.
 */
export const executeAuthenticatedEnvironmentHttpRequest = <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(
  input: Parameters<typeof executeEnvironmentRequest<Group, A, E, R>>[0],
) =>
  input.prepared.httpAuthorization?._tag === "Dpop"
    ? executeEnvironmentRequest(input).pipe(
        Effect.withSpan(ENVIRONMENT_REQUEST_SPAN, { root: true }),
        withRelayClientTracing,
      )
    : executeEnvironmentRequest(input).pipe(Effect.withSpan(ENVIRONMENT_REQUEST_SPAN));

/** Sends the request with this client's own credentials on the supervised environment. */
export const executeConnectedEnvironmentHttpRequest = Effect.fn(
  "clientRuntime.state.executeConnectedEnvironmentHttpRequest",
)(function* <Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1], A, E, R>(
  input: Omit<
    Parameters<typeof executeEnvironmentRequest<Group, A, E, R>>[0],
    "prepared" | "signer" | "remoteAuthorization"
  >,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new RemoteEnvironmentAuthFetchError({
      message: "The environment is not connected.",
      cause: supervisor.target._tag,
    });
  }
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
  });
});

const ENVIRONMENT_REQUEST_SPAN = "clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest";

const executeEnvironmentRequest = Effect.fnUntraced(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly method: HttpMethod.HttpMethod;
  /**
   * The URL to sign, from the group's contract URL builder. It encodes path
   * params exactly like the request client, so the DPoP proof matches the
   * URL actually sent.
   */
  readonly url: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>[Group]) => string;
  readonly timeoutMs: number;
  readonly group: Group;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
  /** Some endpoints report rejected credentials in a successful response. */
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
}): Effect.fn.Return<
  A,
  RemoteEnvironmentRequestError,
  Effect.Services<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>> | R
> {
  let httpBaseUrl = input.prepared.httpBaseUrl;
  const requestUrlFor = (baseUrl: string) =>
    input.url(makeEnvironmentHttpApiUrlBuilder(baseUrl)[input.group]);
  return yield* Effect.gen(function* () {
    let rejectedAccessToken: string | undefined;
    for (;;) {
      let authorization = input.prepared.httpAuthorization;
      if (authorization?._tag === "Dpop") {
        const remote = input.remoteAuthorization;
        if (remote === undefined || Option.isNone(remote)) {
          return yield* new RemoteEnvironmentAuthFetchError({
            message: "No relay authorization service is available for the environment request.",
            cause: input.prepared.target._tag,
          });
        }
        const current = yield* remote.value
          .authorizeDpopHttp({
            expectedEnvironmentId: input.prepared.environmentId,
            ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RemoteEnvironmentAuthFetchError({
                  message: "Could not authorize the environment request.",
                  cause,
                }),
            ),
          );
        // A learned direct route keeps its own origin; only the token renews.
        if (input.prepared.target._tag === "RelayConnectionTarget") {
          httpBaseUrl = current.httpBaseUrl;
        }
        authorization = current.httpAuthorization;
      }

      const requestUrl = requestUrlFor(httpBaseUrl);
      const client = yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, input.group);
      const headers = yield* buildEnvironmentAuthHeaders(
        authorization,
        input.method,
        requestUrl,
        input.signer,
      );
      const result = yield* executeEnvironmentHttpRequest(
        requestUrl,
        input.timeoutMs,
        withEnvironmentCredentials(authorization, input.request({ client, headers })),
      ).pipe(Effect.result);

      if (Result.isFailure(result)) {
        if (
          authorization?._tag === "Dpop" &&
          rejectedAccessToken === undefined &&
          result.failure._tag === "EnvironmentAuthInvalidError" &&
          result.failure.reason === "invalid_credential"
        ) {
          rejectedAccessToken = authorization.accessToken;
          continue;
        }
        return yield* result.failure;
      }

      if (
        authorization?._tag === "Dpop" &&
        input.isUnauthorizedResponse?.(result.success) === true
      ) {
        if (rejectedAccessToken === undefined) {
          rejectedAccessToken = authorization.accessToken;
          continue;
        }
        return yield* new RemoteEnvironmentAuthFetchError({
          message: "The environment rejected the renewed session authorization.",
          cause: result.success,
        });
      }
      return result.success;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(
          new RemoteEnvironmentAuthTimeoutError(requestUrlFor(httpBaseUrl), input.timeoutMs),
        ),
    }),
  );
});
