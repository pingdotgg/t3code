// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createPublicKey.
import {
  AuthStandardClientScopes,
  EnvironmentAuthenticatedPrincipal,
  type EnvironmentCloudLinkStateResult,
  type EnvironmentCloudPreferencesRequest,
  type EnvironmentCloudRelayConfigResult,
} from "@t3tools/contracts";
import {
  RelayCloudEnvironmentHealthProofPayload,
  type RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialProofPayload,
  type RelayCloudMintCredentialRequest,
  type RelayEnvironmentConfigRequest,
  type RelayEnvironmentHealthResponse,
  type RelayEnvironmentHealthResponseProofPayload,
  type RelayEnvironmentLinkProof,
  type RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkResponse,
  type RelayEnvironmentMintResponse,
  type RelayEnvironmentMintResponseProofPayload,
  type RelayLinkProofRequest,
  type RelayManagedEndpointOrigin,
  type RelayManagedEndpointRecoveryProofPayload,
  RelayManagedEndpointRecoveryRegistrationResponse,
  RelayManagedEndpointRecoveryResponse,
  type RelayManagedEndpointRuntimeConfig,
  RelayOkResponse,
} from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_LINK_PROOF_TYP,
  RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpServerRequest,
} from "effect/http";
import * as HttpServer from "effect/http/HttpServer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import {
  type CliDesiredLinkMode,
  readCliDesiredCloudLink,
  readCliDesiredLinkMode,
  setCliDesiredCloudLink,
} from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  decodeConfirmedOrigin,
  decodeRuntimeConfig,
  encodeConfirmedOriginJson,
  encodeEndpointRuntimeConfigJson,
  HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  readRelayConnection,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  filterRelayResponse,
  relayRequestError,
  type RelayRequestError,
  shouldRetryRelayRequest,
} from "./relayResponse.ts";
import {
  hasBoundedCloudProofLifetime,
  hasExactScope,
  hasForwardedAuthorityHeaders,
  isAllowedEndpointOrigin,
  isSupportedLinkProviderKind,
  linkProofScopes,
  managedEndpointRuntimeConfigsMatch,
  parseManagedEndpointLocalOrigin,
  requestAbsoluteUrl,
} from "./linkChecks.ts";
import { CLOUD_MINT_NONCE_PREFIX, CLOUD_MINT_JTI_PREFIX, CLOUD_HEALTH_NONCE_PREFIX, CLOUD_HEALTH_JTI_PREFIX, MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT, CloudLinkRelayConfigInvalidError, CloudLinkOriginInvalidError, CloudLinkNotLinkedError, CloudLinkAccountMismatchError, CloudLinkAuthorizationMissingError, CloudLinkProofRejectedError, CloudLinkProofReplayedError, CloudLinkTunnelSupersededError, CloudLinkEndpointUnavailableError, CloudLinkInternalError, internalError, shouldRetryCloudLink, rollbackFailed, requireRelayUrl, bytesToString, stringToBytes, consumeCloudReplayGuards, validateCloudMintPublicKey, validateRelayConfigPayload, normalizePemForSignedPayload, decodeCloudHealthProof, decodeCloudMintProof } from "./CloudLink-part2.ts";

export const makeCloudLinkState = Effect.fn("makeCloudLinkState")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const endpointRuntime = yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime;
  const reachability = yield* ConnectReachability.ConnectReachability;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const cliTokenManager = yield* CliTokenManager.CloudCliTokenManager;
  const httpClient = yield* HttpClient.HttpClient;
  const httpServer = yield* HttpServer.HttpServer;
  const awarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;

  const withSecrets = Effect.provideService(ServerSecretStore.ServerSecretStore, secrets);
  const withRuntimeFiles = <A, E>(
    effect: Effect.Effect<A, E, ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const validateLinkedCloudUser = (
    cloudUserId: string,
  ): Effect.Effect<void, EnvironmentAuth.ServerAuthInternalError | CloudLinkAccountMismatchError> =>
    secrets.get(CLOUD_LINKED_USER_ID).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthLinkedCloudAccountVerificationError({
            cause,
          }),
      ),
      Effect.flatMap((existing) => {
        if (Option.isNone(existing)) {
          return Effect.void;
        }
        const existingCloudUserId = bytesToString(existing.value);
        return existingCloudUserId === cloudUserId
          ? Effect.void
          : Effect.fail(new CloudLinkAccountMismatchError({}));
      }),
    );

  const readInstalledCloudUserId: Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError> =
    secrets.get(CLOUD_LINKED_USER_ID).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthLinkedCloudAccountReadError({
            cause,
          }),
      ),
      Effect.flatMap((bytes) =>
        Option.isSome(bytes)
          ? Effect.succeed(bytesToString(bytes.value))
          : Effect.fail(new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({})),
      ),
    );

  const makeCloudLinkProof = Effect.fn("environment.cloud.makeLinkProof")(function* (
    request: RelayLinkProofRequest,
    requestUrl: string,
    allowNonLoopbackRequestHost = false,
  ) {
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
    if (
      !isSupportedLinkProviderKind(request) ||
      !isAllowedEndpointOrigin({
        origin: request.origin,
        requestUrl,
        allowNonLoopbackRequestHost,
      })
    ) {
      return yield* new CloudLinkOriginInvalidError({ origin: "endpoint" });
    }
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: 5 });
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const descriptor = yield* environment.getDescriptor;
    const payload = {
      iss: `t3-env:${descriptor.environmentId}`,
      aud: normalizeRelayIssuer(request.relayIssuer),
      sub: descriptor.environmentId,
      jti: yield* random.uuidV4(),
      iat: nowSeconds,
      exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
      challenge: request.challenge,
      descriptor,
      environmentId: descriptor.environmentId,
      environmentPublicKey: normalizePemForSignedPayload(keyPair.publicKey),
      endpoint: request.endpoint,
      origin: request.origin,
      scopes: linkProofScopes(request),
    } satisfies RelayEnvironmentLinkProofPayload;
    return yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_LINK_PROOF_TYP,
      payload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudLinkJwtSigningError({
            cause,
          }),
      ),
    );
  });

  const linkProof = Effect.fn("environment.cloud.linkProof")(
    function* (request: RelayLinkProofRequest, httpRequest: HttpServerRequest.HttpServerRequest) {
      const requestUrl = requestAbsoluteUrl(httpRequest);
      if (requestUrl === null || hasForwardedAuthorityHeaders(httpRequest)) {
        return yield* new CloudLinkOriginInvalidError({ origin: "endpoint" });
      }
      const principal = yield* EnvironmentAuthenticatedPrincipal;
      // WSL desktop requests use the distro IP; only the server-issued bootstrap subject qualifies.
      return yield* makeCloudLinkProof(
        request,
        requestUrl,
        principal.subject === "desktop-bootstrap",
      );
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("generate-link-proof")),
  );

  const activateManagedTunnel = Effect.fn("environment.cloud.activateManagedTunnel")(
    function* (input: {
      readonly config: RelayManagedEndpointRuntimeConfig;
      readonly configJson: string;
      readonly origin: RelayManagedEndpointOrigin;
    }) {
      return yield* endpointRuntime.withLinkStateLock(
        Effect.gen(function* () {
          const currentConfig = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
          if (
            Option.isNone(currentConfig) ||
            bytesToString(currentConfig.value) !== input.configJson
          ) {
            return null;
          }
          const status = yield* endpointRuntime.applyConfig(input.config);
          if (status.status !== "running") {
            return yield* new CloudLinkEndpointUnavailableError({
              reason: "runtime-not-started",
              endpointRuntimeStatus: status,
            });
          }
          const marker = yield* encodeConfirmedOriginJson({
            config: input.config,
            origin: input.origin,
          });
          yield* secrets.set(CLOUD_ENDPOINT_CONFIRMED_ORIGIN, stringToBytes(marker));
          return status;
        }),
      );
    },
  );

  const activateManagedTunnelWithRetry = (
    input: {
      readonly config: RelayManagedEndpointRuntimeConfig;
      readonly configJson: string;
      readonly origin: RelayManagedEndpointOrigin;
    },
    retryRuntimeFailures: boolean,
  ) => {
    const activate = activateManagedTunnel(input);
    return retryRuntimeFailures
      ? activate.pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "CloudLinkEndpointUnavailableError" &&
              ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus(
                error.endpointRuntimeStatus,
              ),
            schedule: Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(30))),
              ),
              Schedule.jittered,
            ),
          }),
        )
      : activate;
  };

  const startManagedTunnelIfOriginConfirmed = Effect.fn(
    "environment.cloud.startManagedCloudTunnelIfOriginConfirmed",
  )(function* (localOrigin: string, options?: { readonly requireConfirmedOrigin?: boolean }) {
    const requireConfirmedOrigin = options?.requireConfirmedOrigin ?? true;
    const parsedOrigin = yield* Effect.try({
      try: () => parseManagedEndpointLocalOrigin(localOrigin),
      catch: () => new CloudLinkOriginInvalidError({ origin: "local" }),
    });
    return yield* endpointRuntime.withLinkStateLock(
      Effect.gen(function* () {
        const [runtimeBytes, markerBytes] = yield* Effect.all([
          secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
          secrets.get(CLOUD_ENDPOINT_CONFIRMED_ORIGIN),
        ]);
        if (Option.isNone(runtimeBytes)) return false;
        const config = Option.getOrNull(decodeRuntimeConfig(bytesToString(runtimeBytes.value)));
        if (config === null || config.providerKind !== "cloudflare_tunnel") return false;
        // Require the relay-confirmed port unless falling back after the relay stayed unreachable.
        if (requireConfirmedOrigin) {
          if (Option.isNone(markerBytes)) return false;
          const marker = Option.getOrNull(decodeConfirmedOrigin(bytesToString(markerBytes.value)));
          if (
            marker === null ||
            !managedEndpointRuntimeConfigsMatch(marker.config, config) ||
            marker.origin.localHttpHost !== parsedOrigin.origin.localHttpHost ||
            marker.origin.localHttpPort !== parsedOrigin.origin.localHttpPort
          ) {
            return false;
          }
        }
        const status = yield* endpointRuntime.applyConfig(config);
        if (status.status !== "running") {
          return yield* new CloudLinkEndpointUnavailableError({
            reason: "runtime-not-started",
            endpointRuntimeStatus: status,
          });
        }
        return true;
      }),
    );
  });

  const applyCloudRelayConfig = Effect.fn("environment.cloud.applyRelayConfig")(function* (
    payload: RelayEnvironmentConfigRequest,
    options?: {
      readonly lockHeld?: boolean;
      readonly confirmedOrigin?: RelayManagedEndpointOrigin;
    },
  ) {
    const apply = Effect.gen(function* () {
      yield* validateRelayConfigPayload(payload);
      yield* validateLinkedCloudUser(payload.cloudUserId);
      yield* validateCloudMintPublicKey(payload.cloudMintPublicKey);
      // Reject unsupported runtimes before they can stop a healthy tunnel.
      if (
        payload.endpointRuntime !== null &&
        payload.endpointRuntime.providerKind !== "cloudflare_tunnel"
      ) {
        return yield* new CloudLinkEndpointUnavailableError({
          reason: "runtime-not-started",
          endpointRuntimeStatus: {
            status: "unsupported",
            providerKind: payload.endpointRuntime.providerKind,
          },
        });
      }
      const endpointRuntimeJson = payload.endpointRuntime
        ? yield* encodeEndpointRuntimeConfigJson(payload.endpointRuntime)
        : null;
      yield* endpointRuntime.applyConfig(null);
      yield* secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN);
      // Store runtime config last so partial writes cannot appear managed or respawn a stale tunnel.
      yield* secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);

      yield* secrets.set(RELAY_URL_SECRET, stringToBytes(payload.relayUrl));
      yield* secrets.set(
        RELAY_ISSUER_SECRET,
        stringToBytes(payload.relayIssuer ?? payload.relayUrl),
      );
      yield* secrets.set(CLOUD_LINKED_USER_ID, stringToBytes(payload.cloudUserId));
      yield* secrets.set(
        RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        stringToBytes(payload.environmentCredential),
      );
      yield* secrets.remove(CLOUD_LINK_REVOKED);
      yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, stringToBytes(payload.cloudMintPublicKey));
      yield* awarenessRelay.requestCatchUp();
      if (endpointRuntimeJson !== null) {
        yield* secrets.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, stringToBytes(endpointRuntimeJson));
      }
      if (payload.endpointRuntime === null || options?.confirmedOrigin === undefined) {
        return {
          ok: true,
          endpointRuntimeStatus: { status: "disabled" },
        } satisfies EnvironmentCloudRelayConfigResult;
      }
      const endpointRuntimeStatus = yield* endpointRuntime.applyConfig(payload.endpointRuntime);
      if (endpointRuntimeStatus.status !== "running") {
        return yield* new CloudLinkEndpointUnavailableError({
          reason: "runtime-not-started",
          endpointRuntimeStatus,
        });
      }
      const marker = yield* encodeConfirmedOriginJson({
        config: payload.endpointRuntime,
        origin: options.confirmedOrigin,
      });
      yield* secrets.set(CLOUD_ENDPOINT_CONFIRMED_ORIGIN, stringToBytes(marker));
      return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
    });
    return yield* options?.lockHeld ? apply : endpointRuntime.withLinkStateLock(apply);
  });

  const relayClientRequest = <A>(input: {
    readonly url: string;
    readonly token: string;
    readonly payload: unknown;
    readonly schema: Schema.Decoder<A>;
    readonly timeout?: Duration.Input;
  }) =>
    HttpClientRequest.post(input.url).pipe(
      HttpClientRequest.bearerToken(input.token),
      HttpClientRequest.bodyJson(input.payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(filterRelayResponse),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(input.schema)),
      Effect.timeout(input.timeout ?? "10 seconds"),
      Effect.mapError(relayRequestError),
      withRelayClientTracing,
    );

  const reconcileDesiredCloudLinkWith = Effect.fn("environment.cloud.reconcileDesiredLinkWith")(
    function* (localOrigin: string) {
      const parsedOrigin = yield* Effect.try({
        try: () => parseManagedEndpointLocalOrigin(localOrigin),
        catch: () => new CloudLinkOriginInvalidError({ origin: "local" }),
      });
      const token = yield* cliTokenManager.getExisting.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new CloudLinkAuthorizationMissingError({})),
            onSome: Effect.succeed,
          }),
        ),
      );
      const mode = yield* readCliDesiredLinkMode.pipe(withSecrets);
      const managedTunnelsEnabled = mode !== "publish_only";
      const relayUrl = yield* requireRelayUrl;
      const challenge = yield* relayClientRequest({
        url: `${relayUrl}/v1/client/environment-link-challenges`,
        token: token.accessToken,
        payload: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled,
        },
        schema: RelayEnvironmentLinkChallengeResponse,
      });
      const proof = yield* makeCloudLinkProof(
        {
          challenge: challenge.challenge,
          relayIssuer: relayUrl,
          endpoint: {
            httpBaseUrl: parsedOrigin.httpBaseUrl,
            wsBaseUrl: parsedOrigin.wsBaseUrl,
            providerKind: managedTunnelsEnabled ? "cloudflare_tunnel" : "manual",
          },
          origin: parsedOrigin.origin,
        },
        parsedOrigin.httpBaseUrl,
      );
      const link = yield* relayClientRequest({
        url: `${relayUrl}/v1/client/environment-links`,
        token: token.accessToken,
        payload: {
          proof,
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled,
        },
        schema: RelayEnvironmentLinkResponse,
        timeout: MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT,
      });
      yield* setCliDesiredCloudLink(true, mode).pipe(withSecrets);
      yield* applyCloudRelayConfig(
        {
          relayUrl,
          relayIssuer: link.relayIssuer,
          cloudUserId: link.cloudUserId,
          environmentCredential: link.environmentCredential,
          cloudMintPublicKey: link.cloudMintPublicKey,
          endpointRuntime: link.endpointRuntime,
        },
        {
          lockHeld: true,
          confirmedOrigin: parsedOrigin.origin,
        },
      );
      return mode;
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("persist-desired-link")),
  );

  const reconcileDesiredLinkIfStillDesired = Effect.fn(
    "environment.cloud.reconcileDesiredLinkIfStillDesired",
  )(function* (localOrigin: string) {
    return yield* endpointRuntime.withLinkStateLock(
      Effect.gen(function* () {
        if (!(yield* readCliDesiredCloudLink.pipe(withSecrets))) {
          return null;
        }
        return yield* reconcileDesiredCloudLinkWith(localOrigin);
      }),
    );
  });

  return {
    secrets,
    environment,
    endpointRuntime,
    reachability,
    environmentAuth,
    cliTokenManager,
    httpClient,
    httpServer,
    awarenessRelay,
    random,
    config,
    fileSystem,
    path,
    managedPolicy,
    withSecrets,
    withRuntimeFiles,
    validateLinkedCloudUser,
    readInstalledCloudUserId,
    makeCloudLinkProof,
    linkProof,
    activateManagedTunnel,
    activateManagedTunnelWithRetry,
    startManagedTunnelIfOriginConfirmed,
    applyCloudRelayConfig,
    relayClientRequest,
    reconcileDesiredCloudLinkWith,
    reconcileDesiredLinkIfStillDesired,
  };
});
