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
  RelayUnregisterDeviceEndpoint,
} from "@t3tools/contracts/relay";
import { encodeOAuthScope, oauthScopeSetEquals } from "@t3tools/shared/oauthScope";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";
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

export interface ManagedRelayDpopSignerShape {
  readonly thumbprint: Effect.Effect<string, ManagedRelayDpopSignerError>;
  readonly createProof: (
    input: ManagedRelayDpopProofInput,
  ) => Effect.Effect<string, ManagedRelayDpopSignerError>;
}

export class ManagedRelayDpopSigner extends Context.Service<
  ManagedRelayDpopSigner,
  ManagedRelayDpopSignerShape
>()("@t3tools/client-runtime/managedRelay/ManagedRelayDpopSigner") {}

export class ManagedRelayClientError extends Data.TaggedError("ManagedRelayClientError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const MANAGED_RELAY_REQUEST_TIMEOUT_MS = 10_000;

interface CachedRelayAccessToken {
  readonly clerkToken: string;
  readonly thumbprint: string;
  readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
  readonly accessToken: string;
  readonly expiresAtMillis: number;
}

export interface ManagedRelayAuthorization {
  readonly accessToken: string;
  readonly proof: string;
  readonly thumbprint: string;
}

export interface ManagedRelayClientLayerOptions {
  readonly relayUrl: string;
  readonly clientId: RelayPublicClientId;
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
>()("@t3tools/client-runtime/managedRelay/ManagedRelayClient") {}

function relayClientError(message: string, cause?: unknown): ManagedRelayClientError {
  return new ManagedRelayClientError({ message, ...(cause === undefined ? {} : { cause }) });
}

function timeoutRelayRequest(message: string) {
  return <A, E, R>(
    request: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ManagedRelayClientError, R> =>
    request.pipe(
      Effect.timeoutOption(Duration.millis(MANAGED_RELAY_REQUEST_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(relayClientError(message)),
          onSome: Effect.succeed,
        }),
      ),
    );
}

function tokenMatches(
  token: CachedRelayAccessToken,
  input: {
    readonly clerkToken: string;
    readonly thumbprint: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly nowMillis: number;
  },
): boolean {
  return (
    token.clerkToken === input.clerkToken &&
    token.thumbprint === input.thumbprint &&
    token.expiresAtMillis > input.nowMillis + 5_000 &&
    input.scopes.every((scope) => token.scopes.includes(scope))
  );
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
  const unavailable = () =>
    Effect.fail(relayClientError("Relay URL must be a secure absolute HTTPS origin."));
  return ManagedRelayClient.of({
    relayUrl,
    listEnvironments: unavailable,
    listDevices: unavailable,
    createEnvironmentLinkChallenge: unavailable,
    linkEnvironment: unavailable,
    unlinkEnvironment: unavailable,
    getEnvironmentStatus: unavailable,
    connectEnvironment: unavailable,
    registerDevice: unavailable,
    unregisterDevice: unavailable,
    registerLiveActivity: unavailable,
    resetTokenCache: Effect.void,
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
      const cachedTokens = yield* SynchronizedRef.make<ReadonlyArray<CachedRelayAccessToken>>([]);
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

      const obtainAccessToken = Effect.fn("clientRuntime.managedRelay.obtainAccessToken")(
        function* (input: {
          readonly clerkToken: string;
          readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
          readonly thumbprint: string;
        }) {
          const nowMillis = yield* Clock.currentTimeMillis;
          return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) => {
            const activeTokens = tokens.filter(
              (token) => token.expiresAtMillis > nowMillis + 5_000,
            );
            const cached = activeTokens.find((token) =>
              tokenMatches(token, { ...input, nowMillis }),
            );
            if (cached) {
              return Effect.succeed([cached, activeTokens] as const);
            }
            return Effect.gen(function* () {
              const proof = yield* signer
                .createProof(dpopProofTargets.exchangeAccessToken())
                .pipe(
                  Effect.mapError((cause) =>
                    relayClientError("Could not create relay token DPoP proof.", cause),
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
                  Effect.mapError((cause) =>
                    relayClientError("Could not exchange relay DPoP access token.", cause),
                  ),
                  timeoutRelayRequest("Relay DPoP access token exchange timed out."),
                );
              if (!oauthScopeSetEquals(response.scope, input.scopes)) {
                return yield* relayClientError(
                  "Relay granted unexpected DPoP access token scopes.",
                );
              }
              const next: CachedRelayAccessToken = {
                clerkToken: input.clerkToken,
                thumbprint: input.thumbprint,
                scopes: input.scopes,
                accessToken: response.access_token,
                expiresAtMillis: nowMillis + response.expires_in * 1_000,
              };
              return [next, [...activeTokens, next]] as const;
            });
          });
        },
      );

      const authorize = (input: {
        readonly clerkToken: string;
        readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
        readonly target: DpopProofTarget;
      }) =>
        Effect.gen(function* () {
          const thumbprint = yield* signer.thumbprint.pipe(
            Effect.mapError((cause) =>
              relayClientError("Could not load relay DPoP proof key.", cause),
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
                relayClientError("Could not create relay request DPoP proof.", cause),
              ),
            );
          return { accessToken: token.accessToken, proof, thumbprint };
        });

      const authorizeMobileRegistration = (input: {
        readonly clerkToken: string;
        readonly target: DpopProofTarget;
      }) =>
        authorize({
          ...input,
          scopes: [RelayMobileRegistrationScope],
        });

      return ManagedRelayClient.of({
        relayUrl,
        listEnvironments: (input) =>
          client.client.listEnvironments({ headers: bearerHeaders(input.clerkToken) }).pipe(
            Effect.map((response) => response.environments),
            Effect.mapError((cause) =>
              relayClientError("Could not list relay-managed environments.", cause),
            ),
            timeoutRelayRequest("Relay environment listing timed out."),
            withRelayClientTracing,
          ),
        listDevices: (input) =>
          client.client
            .listDevices({
              headers: bearerHeaders(input.clerkToken),
            })
            .pipe(
              Effect.map((response) => response.devices),
              Effect.mapError((cause) =>
                relayClientError("Could not list relay client devices.", cause),
              ),
              timeoutRelayRequest("Relay client device listing timed out."),
              withRelayClientTracing,
            ),
        createEnvironmentLinkChallenge: (input) =>
          client.client
            .createEnvironmentLinkChallenge({
              headers: bearerHeaders(input.clerkToken),
              payload: input.payload,
            })
            .pipe(
              Effect.mapError((cause) =>
                relayClientError("Could not create relay environment link challenge.", cause),
              ),
              timeoutRelayRequest("Relay environment link challenge timed out."),
              withRelayClientTracing,
            ),
        linkEnvironment: (input) =>
          client.client
            .linkEnvironment({
              headers: bearerHeaders(input.clerkToken),
              payload: input.payload,
            })
            .pipe(
              Effect.mapError((cause) =>
                relayClientError("Could not link relay environment.", cause),
              ),
              timeoutRelayRequest("Relay environment linking timed out."),
              withRelayClientTracing,
            ),
        unlinkEnvironment: (input) =>
          client.client
            .unlinkEnvironment({
              headers: bearerHeaders(input.clerkToken),
              params: { environmentId: input.environmentId },
            })
            .pipe(
              Effect.mapError((cause) =>
                relayClientError("Could not unlink relay environment.", cause),
              ),
              timeoutRelayRequest("Relay environment unlinking timed out."),
              withRelayClientTracing,
            ),
        getEnvironmentStatus: (input) =>
          Effect.gen(function* () {
            const authorization = yield* authorize({
              clerkToken: input.clerkToken,
              scopes: input.scopes,
              target: dpopProofTargets.getEnvironmentStatus(input.environmentId),
            });
            return yield* client.dpopClient
              .getEnvironmentStatus({
                headers: dpopHeaders(authorization),
                params: { environmentId: input.environmentId },
              })
              .pipe(
                Effect.mapError((cause) =>
                  relayClientError("Could not get relay environment status.", cause),
                ),
                timeoutRelayRequest("Relay environment status request timed out."),
              );
          }).pipe(withRelayClientTracing),
        connectEnvironment: (input) =>
          Effect.gen(function* () {
            const authorization = yield* authorize({
              clerkToken: input.clerkToken,
              scopes: input.scopes,
              target: dpopProofTargets.connectEnvironment(input.environmentId),
            });
            const payload: RelayEnvironmentConnectRequest = {
              ...(input.deviceId ? { deviceId: input.deviceId } : {}),
              clientKeyThumbprint: authorization.thumbprint,
            };
            return yield* client.dpopClient
              .connectEnvironment({
                headers: dpopHeaders(authorization),
                params: { environmentId: input.environmentId },
                payload,
              })
              .pipe(
                Effect.mapError((cause) =>
                  relayClientError("Could not connect relay environment.", cause),
                ),
                timeoutRelayRequest("Relay environment connection timed out."),
              );
          }).pipe(withRelayClientTracing),
        registerDevice: (input) =>
          Effect.gen(function* () {
            const authorization = yield* authorizeMobileRegistration({
              clerkToken: input.clerkToken,
              target: dpopProofTargets.registerDevice(),
            });
            return yield* client.mobile
              .registerDevice({
                headers: dpopHeaders(authorization),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError((cause) =>
                  relayClientError("Could not register relay mobile device.", cause),
                ),
                timeoutRelayRequest("Relay mobile device registration timed out."),
              );
          }).pipe(withRelayClientTracing),
        unregisterDevice: (input) =>
          Effect.gen(function* () {
            const authorization = yield* authorizeMobileRegistration({
              clerkToken: input.clerkToken,
              target: dpopProofTargets.unregisterDevice(input.deviceId),
            });
            return yield* client.mobile
              .unregisterDevice({
                headers: dpopHeaders(authorization),
                params: { deviceId: input.deviceId },
              })
              .pipe(
                Effect.mapError((cause) =>
                  relayClientError("Could not unregister relay mobile device.", cause),
                ),
                timeoutRelayRequest("Relay mobile device unregistration timed out."),
              );
          }).pipe(withRelayClientTracing),
        registerLiveActivity: (input) =>
          Effect.gen(function* () {
            const authorization = yield* authorizeMobileRegistration({
              clerkToken: input.clerkToken,
              target: dpopProofTargets.registerLiveActivity(),
            });
            return yield* client.mobile
              .registerLiveActivity({
                headers: dpopHeaders(authorization),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError((cause) =>
                  relayClientError("Could not register relay live activity.", cause),
                ),
                timeoutRelayRequest("Relay Live Activity registration timed out."),
              );
          }).pipe(withRelayClientTracing),
        resetTokenCache: SynchronizedRef.set(cachedTokens, []),
      });
    }),
  );
}
