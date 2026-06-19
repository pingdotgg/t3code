import {
  RelayAccessTokenType,
  RelayApi,
  type RelayClientEnvironmentRecord,
  type RelayClientDeviceRecord,
  RelayConnectEnvironmentEndpoint,
  type RelayDeviceRegistrationRequest,
  type RelayDpopAccessTokenScope,
  RelayDpopTokenExchangeGrantType,
  type RelayEnvironmentConnectRequest,
  type RelayEnvironmentConnectResponse,
  type RelayEnvironmentLinkChallengeRequest,
  type RelayEnvironmentLinkChallengeResponse,
  type RelayEnvironmentLinkRequest,
  type RelayEnvironmentLinkResponse,
  type RelayEnvironmentStatusResponse,
  RelayExchangeDpopAccessTokenEndpoint,
  RelayGetEnvironmentStatusEndpoint,
  RelayJwtSubjectTokenType,
  type RelayLiveActivityRegistrationRequest,
  RelayMobileRegistrationScope,
  type RelayOkResponse,
  type RelayPublicClientId,
  RelayRegisterDeviceEndpoint,
  RelayRegisterLiveActivityEndpoint,
  RelayProtectedError,
  type RelayProtectedError as RelayProtectedErrorType,
  RelayUnregisterDeviceEndpoint,
} from "@t3tools/contracts/relay";
import { encodeOAuthScope, oauthScopeSetEquals } from "@t3tools/shared/oauthScope";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClientError } from "effect/unstable/http";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

export interface ManagedRelayDpopProofInput {
  readonly method: HttpMethod;
  readonly url: string;
  readonly accessToken?: string;
}

export class ManagedRelayDpopSignerError extends Data.TaggedError("ManagedRelayDpopSignerError")<{
  readonly cause: unknown;
}> {}

export class ManagedRelayRequestTimeoutError extends Data.TaggedError(
  "ManagedRelayRequestTimeoutError",
)<{
  readonly message: string;
}> {}

type RelayHttpRequestError =
  | RelayProtectedErrorType
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | ManagedRelayRequestTimeoutError;

export interface ManagedRelayDpopSignerShape {
  readonly thumbprint: Effect.Effect<string, ManagedRelayDpopSignerError>;
  readonly createProof: (
    input: ManagedRelayDpopProofInput,
  ) => Effect.Effect<string, ManagedRelayDpopSignerError>;
}

export class ManagedRelayDpopSigner extends Context.Service<
  ManagedRelayDpopSigner,
  ManagedRelayDpopSignerShape
>()("@t3tools/client-runtime/relay/managedRelay/ManagedRelayDpopSigner") {}

export class ManagedRelayClientError extends Data.TaggedError("ManagedRelayClientError")<{
  readonly message: string;
  readonly cause?: RelayHttpRequestError | ManagedRelayDpopSignerError;
  readonly relayError?: RelayProtectedErrorType;
  readonly traceId?: string;
}> {}

export const MANAGED_RELAY_REQUEST_TIMEOUT_MS = 10_000;

export interface ManagedRelayAccessTokenCacheEntry {
  readonly accountId: string;
  readonly clientId: RelayPublicClientId;
  readonly relayUrl: string;
  readonly thumbprint: string;
  readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
  readonly accessToken: string;
  readonly expiresAtMillis: number;
}

export interface ManagedRelayAccessTokenStore {
  readonly load: Effect.Effect<ReadonlyArray<ManagedRelayAccessTokenCacheEntry>>;
  readonly save: (entries: ReadonlyArray<ManagedRelayAccessTokenCacheEntry>) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export interface ManagedRelayAuthorization {
  readonly accessToken: string;
  readonly proof: string;
  readonly thumbprint: string;
}

export interface ManagedRelayClientLayerOptions {
  readonly relayUrl: string;
  readonly clientId: RelayPublicClientId;
  readonly accessTokenStore?: ManagedRelayAccessTokenStore;
}

export interface ManagedRelayClientShape {
  readonly relayUrl: string;
  readonly listEnvironments: (input: {
    readonly clerkToken: string;
  }) => Effect.Effect<ReadonlyArray<RelayClientEnvironmentRecord>, ManagedRelayClientError>;
  readonly listDevices: (input: {
    readonly clerkToken: string;
  }) => Effect.Effect<ReadonlyArray<RelayClientDeviceRecord>, ManagedRelayClientError>;
  readonly createEnvironmentLinkChallenge: (input: {
    readonly clerkToken: string;
    readonly payload: RelayEnvironmentLinkChallengeRequest;
  }) => Effect.Effect<RelayEnvironmentLinkChallengeResponse, ManagedRelayClientError>;
  readonly linkEnvironment: (input: {
    readonly clerkToken: string;
    readonly payload: RelayEnvironmentLinkRequest;
  }) => Effect.Effect<RelayEnvironmentLinkResponse, ManagedRelayClientError>;
  readonly unlinkEnvironment: (input: {
    readonly clerkToken: string;
    readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
  }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
  readonly getEnvironmentStatus: (input: {
    readonly clerkToken: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
  }) => Effect.Effect<RelayEnvironmentStatusResponse, ManagedRelayClientError>;
  readonly connectEnvironment: (input: {
    readonly clerkToken: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
    readonly deviceId?: string;
  }) => Effect.Effect<RelayEnvironmentConnectResponse, ManagedRelayClientError>;
  readonly registerDevice: (input: {
    readonly clerkToken: string;
    readonly payload: RelayDeviceRegistrationRequest;
  }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
  readonly unregisterDevice: (input: {
    readonly clerkToken: string;
    readonly deviceId: string;
  }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
  readonly registerLiveActivity: (input: {
    readonly clerkToken: string;
    readonly payload: RelayLiveActivityRegistrationRequest;
  }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
  readonly resetTokenCache: Effect.Effect<void>;
}

export class ManagedRelayClient extends Context.Service<
  ManagedRelayClient,
  ManagedRelayClientShape
>()("@t3tools/client-runtime/relay/managedRelay/ManagedRelayClient") {}

const isRelayProtectedError = Schema.is(RelayProtectedError);

function relayClientError(message: string, cause?: RelayHttpRequestError): ManagedRelayClientError {
  return new ManagedRelayClientError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function relayLocalError(
  message: string,
  cause: ManagedRelayDpopSignerError,
): ManagedRelayClientError {
  return new ManagedRelayClientError({ message, cause });
}

function relayRequestError(message: string) {
  return (cause: RelayHttpRequestError): ManagedRelayClientError =>
    new ManagedRelayClientError({
      message,
      cause,
      ...(isRelayProtectedError(cause) ? { relayError: cause, traceId: cause.traceId } : {}),
    });
}

function isRejectedDpopAccessToken(error: ManagedRelayClientError): boolean {
  return (
    error.relayError?._tag === "RelayAuthInvalidError" &&
    error.relayError.reason === "invalid_bearer"
  );
}

function timeoutRelayRequest(message: string) {
  return <A, E, R>(
    request: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ManagedRelayClientError, R> =>
    request.pipe(
      Effect.timeoutOption(Duration.millis(MANAGED_RELAY_REQUEST_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              relayClientError(message, new ManagedRelayRequestTimeoutError({ message })),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
}

function tokenMatches(
  token: ManagedRelayAccessTokenCacheEntry,
  input: {
    readonly accountId: string;
    readonly clientId: RelayPublicClientId;
    readonly relayUrl: string;
    readonly thumbprint: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly nowMillis: number;
  },
): boolean {
  return (
    token.accountId === input.accountId &&
    token.clientId === input.clientId &&
    token.relayUrl === input.relayUrl &&
    token.thumbprint === input.thumbprint &&
    token.expiresAtMillis > input.nowMillis + 5_000 &&
    input.scopes.every((scope) => token.scopes.includes(scope))
  );
}

function relayAccountId(clerkToken: string): Option.Option<string> {
  try {
    return Option.fromNullishOr(decodeRelayJwt(clerkToken).sub).pipe(
      Option.filter((subject) => subject.length > 0),
    );
  } catch {
    return Option.none();
  }
}

function bearerHeaders(clerkToken: string) {
  return { authorization: `Bearer ${clerkToken}` };
}

function dpopHeaders(authorization: ManagedRelayAuthorization) {
  return {
    authorization: `DPoP ${authorization.accessToken}`,
    dpop: authorization.proof,
  };
}

function disabledManagedRelayClient(relayUrl: string): ManagedRelayClientShape {
  const unavailable = (spanName: string) =>
    Effect.fn(spanName)(function* () {
      return yield* relayClientError("Relay URL must be a secure absolute HTTPS origin.");
    });
  return ManagedRelayClient.of({
    relayUrl,
    listEnvironments: unavailable("clientRuntime.managedRelay.listEnvironments"),
    listDevices: unavailable("clientRuntime.managedRelay.listDevices"),
    createEnvironmentLinkChallenge: unavailable(
      "clientRuntime.managedRelay.createEnvironmentLinkChallenge",
    ),
    linkEnvironment: unavailable("clientRuntime.managedRelay.linkEnvironment"),
    unlinkEnvironment: unavailable("clientRuntime.managedRelay.unlinkEnvironment"),
    getEnvironmentStatus: unavailable("clientRuntime.managedRelay.getEnvironmentStatus"),
    connectEnvironment: unavailable("clientRuntime.managedRelay.connectEnvironment"),
    registerDevice: unavailable("clientRuntime.managedRelay.registerDevice"),
    unregisterDevice: unavailable("clientRuntime.managedRelay.unregisterDevice"),
    registerLiveActivity: unavailable("clientRuntime.managedRelay.registerLiveActivity"),
    resetTokenCache: Effect.void.pipe(
      Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
    ),
  });
}

export function managedRelayClientLayer(options: ManagedRelayClientLayerOptions) {
  return Layer.effect(
    ManagedRelayClient,
    Effect.gen(function* () {
      const relayUrl = normalizeSecureRelayUrl(options.relayUrl);
      if (relayUrl === null) {
        return disabledManagedRelayClient(options.relayUrl);
      }
      const signer = yield* ManagedRelayDpopSigner;
      const client = yield* HttpApiClient.make(RelayApi, { baseUrl: relayUrl });
      const initialTokens = options.accessTokenStore ? yield* options.accessTokenStore.load : [];
      const cachedTokens = yield* SynchronizedRef.make<
        ReadonlyArray<ManagedRelayAccessTokenCacheEntry>
      >(initialTokens.filter((token) => token.clientId === options.clientId));
      const urlBuilder = HttpApiClient.urlBuilder(RelayApi, { baseUrl: relayUrl });

      type DpopProofTarget = Pick<ManagedRelayDpopProofInput, "method" | "url">;
      const dpopProofTargets = {
        exchangeAccessToken: (): DpopProofTarget => ({
          method: RelayExchangeDpopAccessTokenEndpoint.method,
          url: urlBuilder.token.exchangeDpopAccessToken(),
        }),
        getEnvironmentStatus: (
          environmentId: RelayClientEnvironmentRecord["environmentId"],
        ): DpopProofTarget => ({
          method: RelayGetEnvironmentStatusEndpoint.method,
          url: urlBuilder.dpopClient.getEnvironmentStatus({ params: { environmentId } }),
        }),
        connectEnvironment: (
          environmentId: RelayClientEnvironmentRecord["environmentId"],
        ): DpopProofTarget => ({
          method: RelayConnectEnvironmentEndpoint.method,
          url: urlBuilder.dpopClient.connectEnvironment({ params: { environmentId } }),
        }),
        registerDevice: (): DpopProofTarget => ({
          method: RelayRegisterDeviceEndpoint.method,
          url: urlBuilder.mobile.registerDevice(),
        }),
        unregisterDevice: (deviceId: string): DpopProofTarget => ({
          method: RelayUnregisterDeviceEndpoint.method,
          url: urlBuilder.mobile.unregisterDevice({ params: { deviceId } }),
        }),
        registerLiveActivity: (): DpopProofTarget => ({
          method: RelayRegisterLiveActivityEndpoint.method,
          url: urlBuilder.mobile.registerLiveActivity(),
        }),
      };

      const exchangeAccessToken = Effect.fn("clientRuntime.managedRelay.exchangeAccessToken")(
        function* (input: {
          readonly clerkToken: string;
          readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
        }) {
          yield* Effect.annotateCurrentSpan({
            "relay.client_id": options.clientId,
            "relay.scopes": input.scopes.join(" "),
          });
          const proof = yield* signer
            .createProof(dpopProofTargets.exchangeAccessToken())
            .pipe(
              Effect.mapError((cause) =>
                relayLocalError("Could not create relay token DPoP proof.", cause),
              ),
            );
          const response = yield* client.token
            .exchangeDpopAccessToken({
              headers: { dpop: proof },
              payload: {
                grant_type: RelayDpopTokenExchangeGrantType,
                subject_token: input.clerkToken,
                subject_token_type: RelayJwtSubjectTokenType,
                requested_token_type: RelayAccessTokenType,
                resource: relayUrl,
                scope: encodeOAuthScope(input.scopes),
                client_id: options.clientId,
              },
            })
            .pipe(
              Effect.mapError(relayRequestError("Could not exchange relay DPoP access token.")),
              timeoutRelayRequest("Relay DPoP access token exchange timed out."),
            );
          if (!oauthScopeSetEquals(response.scope, input.scopes)) {
            return yield* relayClientError("Relay granted unexpected DPoP access token scopes.");
          }
          return response;
        },
      );

      const obtainAccessToken = Effect.fn("clientRuntime.managedRelay.obtainAccessToken")(
        function* (input: {
          readonly clerkToken: string;
          readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
          readonly thumbprint: string;
        }) {
          yield* Effect.annotateCurrentSpan({
            "relay.client_id": options.clientId,
            "relay.scopes": input.scopes.join(" "),
          });
          const nowMillis = yield* Clock.currentTimeMillis;
          const accountId = relayAccountId(input.clerkToken);
          if (Option.isNone(accountId)) {
            yield* Effect.annotateCurrentSpan({
              "relay.token_cache.result": "bypass",
              "relay.token_cache.bypass_reason": "invalid_subject_token",
            });
            const response = yield* exchangeAccessToken(input);
            return {
              accountId: "",
              clientId: options.clientId,
              relayUrl,
              thumbprint: input.thumbprint,
              scopes: input.scopes,
              accessToken: response.access_token,
              expiresAtMillis: nowMillis + response.expires_in * 1_000,
            } satisfies ManagedRelayAccessTokenCacheEntry;
          }
          return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) =>
            Effect.gen(function* () {
              const activeTokens = tokens.filter(
                (token) => token.expiresAtMillis > nowMillis + 5_000,
              );
              const cached = activeTokens.find((token) =>
                tokenMatches(token, {
                  accountId: accountId.value,
                  clientId: options.clientId,
                  relayUrl,
                  thumbprint: input.thumbprint,
                  scopes: input.scopes,
                  nowMillis,
                }),
              );
              if (cached) {
                yield* Effect.annotateCurrentSpan({
                  "relay.token_cache.result": "hit",
                });
                return [cached, activeTokens] as const;
              }
              yield* Effect.annotateCurrentSpan({
                "relay.token_cache.result": "miss",
              });
              const response = yield* exchangeAccessToken(input);
              const next: ManagedRelayAccessTokenCacheEntry = {
                accountId: accountId.value,
                clientId: options.clientId,
                relayUrl,
                thumbprint: input.thumbprint,
                scopes: input.scopes,
                accessToken: response.access_token,
                expiresAtMillis: nowMillis + response.expires_in * 1_000,
              };
              const nextTokens = [...activeTokens, next];
              if (options.accessTokenStore) {
                yield* options.accessTokenStore.save(nextTokens);
              }
              return [next, nextTokens] as const;
            }),
          ).pipe(Effect.withSpan("clientRuntime.managedRelay.tokenCacheCriticalSection"));
        },
      );

      const authorize = Effect.fn("clientRuntime.managedRelay.authorize")(function* (input: {
        readonly clerkToken: string;
        readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
        readonly target: DpopProofTarget;
      }) {
        yield* Effect.annotateCurrentSpan({
          "relay.client_id": options.clientId,
          "relay.scopes": input.scopes.join(" "),
          "http.request.method": input.target.method,
          "url.full": input.target.url,
        });
        const thumbprint = yield* signer.thumbprint.pipe(
          Effect.mapError((cause) =>
            relayLocalError("Could not load relay DPoP proof key.", cause),
          ),
        );
        const token = yield* obtainAccessToken({
          clerkToken: input.clerkToken,
          scopes: input.scopes,
          thumbprint,
        });
        const proof = yield* signer
          .createProof({
            ...input.target,
            accessToken: token.accessToken,
          })
          .pipe(
            Effect.mapError((cause) =>
              relayLocalError("Could not create relay request DPoP proof.", cause),
            ),
          );
        return { accessToken: token.accessToken, proof, thumbprint };
      });

      const invalidateAccessToken = Effect.fn("clientRuntime.managedRelay.invalidateAccessToken")(
        function* (accessToken: string) {
          return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) => {
            const nextTokens = tokens.filter((token) => token.accessToken !== accessToken);
            if (nextTokens.length === tokens.length) {
              return Effect.succeed([false, tokens] as const);
            }
            return (
              options.accessTokenStore ? options.accessTokenStore.save(nextTokens) : Effect.void
            ).pipe(Effect.as([true, nextTokens] as const));
          });
        },
      );

      const runDpopRequest = <A>(
        input: {
          readonly clerkToken: string;
          readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
          readonly target: DpopProofTarget;
        },
        request: (
          authorization: ManagedRelayAuthorization,
        ) => Effect.Effect<A, ManagedRelayClientError>,
      ): Effect.Effect<A, ManagedRelayClientError> => {
        const attempt = (
          refreshRejectedToken: boolean,
        ): Effect.Effect<A, ManagedRelayClientError> =>
          authorize(input).pipe(
            Effect.flatMap((authorization) =>
              request(authorization).pipe(
                Effect.catch((error) => {
                  if (!isRejectedDpopAccessToken(error)) {
                    return Effect.fail(error);
                  }
                  return invalidateAccessToken(authorization.accessToken).pipe(
                    Effect.tap((invalidated) =>
                      Effect.annotateCurrentSpan({
                        "relay.token_cache.invalidated": invalidated,
                        "relay.token_cache.invalidation_reason": "invalid_bearer",
                        "relay.token_cache.retry_after_invalidation": refreshRejectedToken,
                      }),
                    ),
                    Effect.tap((invalidated) =>
                      invalidated && refreshRejectedToken
                        ? Effect.logWarning(
                            "Relay rejected a cached DPoP access token; refreshing it once.",
                          )
                        : Effect.void,
                    ),
                    Effect.andThen(refreshRejectedToken ? attempt(false) : Effect.fail(error)),
                  );
                }),
              ),
            ),
          );
        return attempt(true);
      };

      const mobileRegistrationRequest = <A>(
        input: {
          readonly clerkToken: string;
          readonly target: DpopProofTarget;
        },
        request: (
          authorization: ManagedRelayAuthorization,
        ) => Effect.Effect<A, ManagedRelayClientError>,
      ) =>
        runDpopRequest(
          {
            ...input,
            scopes: [RelayMobileRegistrationScope],
          },
          request,
        );

      return ManagedRelayClient.of({
        relayUrl,
        listEnvironments: Effect.fnUntraced(
          function* (input) {
            return yield* client.client
              .listEnvironments({ headers: bearerHeaders(input.clerkToken) })
              .pipe(
                Effect.map((response) => response.environments),
                Effect.mapError(relayRequestError("Could not list relay-managed environments.")),
                timeoutRelayRequest("Relay environment listing timed out."),
              );
          },
          Effect.withSpan("clientRuntime.managedRelay.listEnvironments"),
          withRelayClientTracing,
        ),
        listDevices: Effect.fnUntraced(
          function* (input) {
            return yield* client.client
              .listDevices({
                headers: bearerHeaders(input.clerkToken),
              })
              .pipe(
                Effect.map((response) => response.devices),
                Effect.mapError(relayRequestError("Could not list relay client devices.")),
                timeoutRelayRequest("Relay client device listing timed out."),
              );
          },
          Effect.withSpan("clientRuntime.managedRelay.listDevices"),
          withRelayClientTracing,
        ),
        createEnvironmentLinkChallenge: Effect.fnUntraced(
          function* (input) {
            return yield* client.client
              .createEnvironmentLinkChallenge({
                headers: bearerHeaders(input.clerkToken),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError(
                  relayRequestError("Could not create relay environment link challenge."),
                ),
                timeoutRelayRequest("Relay environment link challenge timed out."),
              );
          },
          Effect.withSpan("clientRuntime.managedRelay.createEnvironmentLinkChallenge"),
          withRelayClientTracing,
        ),
        linkEnvironment: Effect.fnUntraced(
          function* (input) {
            return yield* client.client
              .linkEnvironment({
                headers: bearerHeaders(input.clerkToken),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("Could not link relay environment.")),
                timeoutRelayRequest("Relay environment linking timed out."),
              );
          },
          Effect.withSpan("clientRuntime.managedRelay.linkEnvironment"),
          withRelayClientTracing,
        ),
        unlinkEnvironment: Effect.fnUntraced(
          function* (input) {
            return yield* client.client
              .unlinkEnvironment({
                headers: bearerHeaders(input.clerkToken),
                params: { environmentId: input.environmentId },
              })
              .pipe(
                Effect.mapError(relayRequestError("Could not unlink relay environment.")),
                timeoutRelayRequest("Relay environment unlinking timed out."),
              );
          },
          Effect.withSpan("clientRuntime.managedRelay.unlinkEnvironment"),
          withRelayClientTracing,
        ),
        getEnvironmentStatus: Effect.fnUntraced(
          function* (input) {
            yield* Effect.annotateCurrentSpan({
              "environment.id": input.environmentId,
            });
            return yield* runDpopRequest(
              {
                clerkToken: input.clerkToken,
                scopes: input.scopes,
                target: dpopProofTargets.getEnvironmentStatus(input.environmentId),
              },
              (authorization) =>
                client.dpopClient
                  .getEnvironmentStatus({
                    headers: dpopHeaders(authorization),
                    params: { environmentId: input.environmentId },
                  })
                  .pipe(
                    Effect.mapError(relayRequestError("Could not get relay environment status.")),
                    timeoutRelayRequest("Relay environment status request timed out."),
                  ),
            );
          },
          Effect.withSpan("clientRuntime.managedRelay.getEnvironmentStatus"),
          withRelayClientTracing,
        ),
        connectEnvironment: Effect.fnUntraced(
          function* (input) {
            yield* Effect.annotateCurrentSpan({
              "environment.id": input.environmentId,
            });
            return yield* runDpopRequest(
              {
                clerkToken: input.clerkToken,
                scopes: input.scopes,
                target: dpopProofTargets.connectEnvironment(input.environmentId),
              },
              (authorization) => {
                const payload: RelayEnvironmentConnectRequest = {
                  ...(input.deviceId ? { deviceId: input.deviceId } : {}),
                  clientKeyThumbprint: authorization.thumbprint,
                };
                return client.dpopClient
                  .connectEnvironment({
                    headers: dpopHeaders(authorization),
                    params: { environmentId: input.environmentId },
                    payload,
                  })
                  .pipe(
                    Effect.mapError(relayRequestError("Could not connect relay environment.")),
                    timeoutRelayRequest("Relay environment connection timed out."),
                  );
              },
            );
          },
          Effect.withSpan("clientRuntime.managedRelay.connectEnvironment"),
          withRelayClientTracing,
        ),
        registerDevice: Effect.fnUntraced(
          function* (input) {
            return yield* mobileRegistrationRequest(
              {
                clerkToken: input.clerkToken,
                target: dpopProofTargets.registerDevice(),
              },
              (authorization) =>
                client.mobile
                  .registerDevice({
                    headers: dpopHeaders(authorization),
                    payload: input.payload,
                  })
                  .pipe(
                    Effect.mapError(relayRequestError("Could not register relay mobile device.")),
                    timeoutRelayRequest("Relay mobile device registration timed out."),
                  ),
            );
          },
          Effect.withSpan("clientRuntime.managedRelay.registerDevice"),
          withRelayClientTracing,
        ),
        unregisterDevice: Effect.fnUntraced(
          function* (input) {
            return yield* mobileRegistrationRequest(
              {
                clerkToken: input.clerkToken,
                target: dpopProofTargets.unregisterDevice(input.deviceId),
              },
              (authorization) =>
                client.mobile
                  .unregisterDevice({
                    headers: dpopHeaders(authorization),
                    params: { deviceId: input.deviceId },
                  })
                  .pipe(
                    Effect.mapError(relayRequestError("Could not unregister relay mobile device.")),
                    timeoutRelayRequest("Relay mobile device unregistration timed out."),
                  ),
            );
          },
          Effect.withSpan("clientRuntime.managedRelay.unregisterDevice"),
          withRelayClientTracing,
        ),
        registerLiveActivity: Effect.fnUntraced(
          function* (input) {
            return yield* mobileRegistrationRequest(
              {
                clerkToken: input.clerkToken,
                target: dpopProofTargets.registerLiveActivity(),
              },
              (authorization) =>
                client.mobile
                  .registerLiveActivity({
                    headers: dpopHeaders(authorization),
                    payload: input.payload,
                  })
                  .pipe(
                    Effect.mapError(relayRequestError("Could not register relay live activity.")),
                    timeoutRelayRequest("Relay Live Activity registration timed out."),
                  ),
            );
          },
          Effect.withSpan("clientRuntime.managedRelay.registerLiveActivity"),
          withRelayClientTracing,
        ),
        resetTokenCache: SynchronizedRef.set(cachedTokens, []).pipe(
          Effect.andThen(options.accessTokenStore ? options.accessTokenStore.clear : Effect.void),
          Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
          withRelayClientTracing,
        ),
      });
    }),
  );
}
