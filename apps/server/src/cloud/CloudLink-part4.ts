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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpServerRequest,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import {
  type CliDesiredLinkMode,
  readCliDesiredCloudLink,
  readCliDesiredLinkMode,
  setCliDesiredCloudLink,
} from "./CliState.ts";
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
import { desktopUpdateRestartPending, pendingUpdateHandoffExists } from "./updateHandoff.ts";
import type { ManagedTunnelRecoveryProofInput, CloudLinkBackgroundError, ManagedTunnelRegistration } from "./CloudLink-part2.ts";
import { CLOUD_MINT_NONCE_PREFIX, CLOUD_MINT_JTI_PREFIX, CLOUD_HEALTH_NONCE_PREFIX, CLOUD_HEALTH_JTI_PREFIX, MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT, CloudLinkRelayConfigInvalidError, CloudLinkOriginInvalidError, CloudLinkNotLinkedError, CloudLinkAccountMismatchError, CloudLinkAuthorizationMissingError, CloudLinkProofRejectedError, CloudLinkProofReplayedError, CloudLinkTunnelSupersededError, CloudLinkEndpointUnavailableError, CloudLinkInternalError, internalError, shouldRetryCloudLink, rollbackFailed, requireRelayUrl, bytesToString, stringToBytes, consumeCloudReplayGuards, validateCloudMintPublicKey, validateRelayConfigPayload, normalizePemForSignedPayload, decodeCloudHealthProof, decodeCloudMintProof } from "./CloudLink-part2.ts";

import type { makeCloudLinkState } from "./CloudLink-part3.ts";

type State = Effect.Success<ReturnType<typeof makeCloudLinkState>>;

export const makeCloudLinkStage2 = Effect.fn("makeCloudLinkStage2")(function* (state: State) {
  const {
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
  } = state;
  const makeManagedTunnelRecoveryProof = Effect.fn(
    "environment.cloud.makeManagedTunnelRecoveryProof",
  )(function* (input: ManagedTunnelRecoveryProofInput) {
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
    const configuredIssuer = yield* secrets.get(RELAY_ISSUER_SECRET);
    const now = yield* DateTime.now;
    const issuedAt = Math.floor(now.epochMilliseconds / 1_000);
    const claims = {
      iss: `t3-env:${input.environmentId}`,
      aud: normalizeRelayIssuer(
        Option.isSome(configuredIssuer) ? bytesToString(configuredIssuer.value) : input.relayUrl,
      ),
      sub: input.environmentId,
      jti: yield* random.uuidV4(),
      iat: issuedAt,
      exp: issuedAt + 60,
      environmentId: input.environmentId,
      cloudUserId: input.cloudUserId,
    };
    const payload =
      input.action === "register"
        ? {
            ...claims,
            action: "register" as const,
            tunnelId: input.tunnelId,
            origin: input.origin,
          }
        : { ...claims, action: "recover" as const, origin: input.origin };

    return yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_MANAGED_TUNNEL_RECOVERY_TYP,
      payload,
    }).pipe(
      Effect.mapError(
        (cause) => new CloudLinkInternalError({ operation: "sign-recovery-proof", cause }),
      ),
    );
  });

  /** Keep credentials: clock skew can cause 401s. A relink during the request returns false without marking; accepted registration clears the mark. */
  const markLinkRevoked = (credential: string, cause: RelayRequestError) =>
    endpointRuntime.withLinkStateLock(
      Effect.gen(function* () {
        const current = yield* secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
        if (Option.isNone(current) || bytesToString(current.value) !== credential) {
          return false;
        }
        yield* Effect.logWarning(
          "T3 Connect no longer accepts this environment's link. Link it again to restore remote access.",
          { cause },
        );
        yield* secrets.set(CLOUD_LINK_REVOKED, stringToBytes("true"));
        return true;
      }),
    );

  const registerManagedTunnelRecovery = Effect.fn(
    "environment.cloud.registerManagedCloudTunnelRecovery",
  )(function* (localOrigin: string, options?: { readonly retryRuntimeFailures?: boolean }) {
    const [runtimeConfig, relayUrl, cloudUserId, environmentCredential] = yield* Effect.all([
      secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      secrets.get(RELAY_URL_SECRET),
      secrets.get(CLOUD_LINKED_USER_ID),
      secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (
      Option.isNone(runtimeConfig) ||
      Option.isNone(relayUrl) ||
      Option.isNone(cloudUserId) ||
      Option.isNone(environmentCredential)
    ) {
      return { status: "not_linked" as const };
    }

    const config = Option.getOrNull(decodeRuntimeConfig(bytesToString(runtimeConfig.value)));
    if (config?.providerKind !== "cloudflare_tunnel") {
      return { status: "not_linked" as const };
    }

    const parsedOrigin = yield* Effect.try({
      try: () => parseManagedEndpointLocalOrigin(localOrigin),
      catch: () => new CloudLinkOriginInvalidError({ origin: "local" }),
    });
    if (config.tunnelId === undefined) {
      return { status: "recovery_required" as const, config };
    }
    const origin = parsedOrigin.origin;
    const environmentId = yield* environment.getEnvironmentId;
    const relayUrlValue = bytesToString(relayUrl.value);
    const cloudUserIdValue = bytesToString(cloudUserId.value);
    const proof = yield* makeManagedTunnelRecoveryProof({
      action: "register",
      environmentId,
      cloudUserId: cloudUserIdValue,
      relayUrl: relayUrlValue,
      tunnelId: config.tunnelId,
      origin,
    });
    const credential = bytesToString(environmentCredential.value);
    const registered = yield* relayClientRequest({
      url: `${relayUrlValue}/v1/environments/${encodeURIComponent(environmentId)}/tunnel/recovery`,
      token: credential,
      payload: {
        cloudUserId: cloudUserIdValue,
        tunnelId: config.tunnelId,
        origin,
        proof,
      },
      schema: RelayManagedEndpointRecoveryRegistrationResponse,
    }).pipe(
      Effect.catchTags({
        RelayRequestError: (error) =>
          error.rejection === "unauthorized"
            ? markLinkRevoked(credential, error).pipe(
                Effect.map((marked) => (marked ? ("revoked" as const) : ("superseded" as const))),
              )
            : Effect.fail(error),
      }),
    );
    if (registered === "revoked" || registered === "superseded") {
      return { status: registered };
    }
    yield* secrets.remove(CLOUD_LINK_REVOKED);
    if (registered.status === "recovery_required") {
      return { status: registered.status, config };
    }
    const endpointRuntimeStatus = yield* activateManagedTunnelWithRetry(
      {
        config,
        configJson: bytesToString(runtimeConfig.value),
        origin,
      },
      options?.retryRuntimeFailures === true,
    );
    return endpointRuntimeStatus === null
      ? { status: "superseded" as const }
      : { status: "ready" as const, endpointRuntimeStatus };
  });

  const recoverManagedTunnel = Effect.fn("environment.cloud.recoverManagedCloudTunnel")(function* (
    localOrigin: string,
    expectedConfig?: RelayManagedEndpointRuntimeConfig,
    options?: { readonly retryRuntimeFailures?: boolean },
  ) {
    const [runtimeConfig, relayUrl, cloudUserId, environmentCredential] = yield* Effect.all([
      secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      secrets.get(RELAY_URL_SECRET),
      secrets.get(CLOUD_LINKED_USER_ID),
      secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (
      Option.isNone(runtimeConfig) ||
      Option.isNone(relayUrl) ||
      Option.isNone(cloudUserId) ||
      Option.isNone(environmentCredential)
    ) {
      return false;
    }
    if (expectedConfig !== undefined) {
      const current = Option.getOrNull(decodeRuntimeConfig(bytesToString(runtimeConfig.value)));
      if (
        current === null ||
        current.providerKind !== expectedConfig.providerKind ||
        current.connectorToken !== expectedConfig.connectorToken ||
        current.tunnelId !== expectedConfig.tunnelId ||
        current.tunnelName !== expectedConfig.tunnelName
      ) {
        return false;
      }
    }

    const parsedOrigin = yield* Effect.try({
      try: () => parseManagedEndpointLocalOrigin(localOrigin),
      catch: () => new CloudLinkOriginInvalidError({ origin: "local" }),
    });

    const environmentId = yield* environment.getEnvironmentId;
    const relayUrlValue = bytesToString(relayUrl.value);
    const cloudUserIdValue = bytesToString(cloudUserId.value);
    const origin = parsedOrigin.origin;
    const proof = yield* makeManagedTunnelRecoveryProof({
      action: "recover",
      environmentId,
      cloudUserId: cloudUserIdValue,
      relayUrl: relayUrlValue,
      origin,
    });
    const credential = bytesToString(environmentCredential.value);
    const recovered = yield* relayClientRequest({
      url: `${relayUrlValue}/v1/environments/${encodeURIComponent(environmentId)}/tunnel`,
      token: credential,
      payload: {
        cloudUserId: cloudUserIdValue,
        origin,
        proof,
      },
      schema: RelayManagedEndpointRecoveryResponse,
      timeout: MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT,
    }).pipe(
      Effect.tapError((error) =>
        error.rejection === "unauthorized" ? markLinkRevoked(credential, error) : Effect.void,
      ),
    );
    if (recovered.endpointRuntime.providerKind !== "cloudflare_tunnel") {
      return yield* new CloudLinkInternalError({ operation: "unsupported-recovered-tunnel" });
    }

    const encoded = yield* encodeEndpointRuntimeConfigJson(recovered.endpointRuntime).pipe(
      Effect.mapError(
        (cause) => new CloudLinkInternalError({ operation: "persist-recovered-tunnel", cause }),
      ),
    );
    const stored = yield* endpointRuntime.withLinkStateLock(
      Effect.gen(function* () {
        const currentConfig = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
        if (
          Option.isNone(currentConfig) ||
          bytesToString(currentConfig.value) !== bytesToString(runtimeConfig.value)
        ) {
          return false;
        }
        yield* secrets.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, stringToBytes(encoded));
        yield* secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN);
        yield* secrets.remove(CLOUD_LINK_REVOKED);
        return true;
      }),
    );
    if (!stored) return false;
    const status = yield* activateManagedTunnelWithRetry(
      {
        config: recovered.endpointRuntime,
        configJson: encoded,
        origin,
      },
      options?.retryRuntimeFailures === true,
    );
    return status !== null;
  });

  const applyRelayConfig = Effect.fn("environment.cloud.relayConfig")(
    function* (payload: RelayEnvironmentConfigRequest) {
      const result = yield* applyCloudRelayConfig(payload);
      if (payload.endpointRuntime?.providerKind === "cloudflare_tunnel") {
        const address = httpServer.address;
        if (typeof address === "string" || !("port" in address)) {
          return yield* new CloudLinkInternalError({ operation: "resolve-server-origin" });
        }
        const registration = yield* registerManagedTunnelRecovery(
          `http://${loopbackUrlHostForAddress(address)}:${address.port}`,
        ).pipe(
          Effect.retry({
            times: 2,
            while: (error) =>
              shouldRetryCloudLink(error) && error._tag !== "CloudLinkEndpointUnavailableError",
          }),
        );
        if (registration.status === "superseded") {
          return yield* new CloudLinkTunnelSupersededError({});
        }
        if (registration.status === "recovery_required") {
          yield* endpointRuntime.requestRecovery(registration.config);
        }
        if (registration.status !== "ready") {
          return yield* new CloudLinkEndpointUnavailableError({
            reason: "origin-unconfirmed",
            endpointRuntimeStatus: { status: "disabled" },
          });
        }
        return {
          ok: true,
          endpointRuntimeStatus: registration.endpointRuntimeStatus,
        } satisfies EnvironmentCloudRelayConfigResult;
      }
      return result;
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("persist-relay-config")),
    Effect.catchTags({
      SchemaError: internalError("persist-relay-config"),
    }),
  );

  // Cloudflare bills provisioned tunnels even while environments are offline.
  const releaseManagedTunnelOnShutdown = Effect.fn(
    "environment.cloud.releaseManagedTunnelOnShutdown",
  )(function* () {
    const runtimeConfig = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
    if (Option.isNone(runtimeConfig)) {
      return false;
    }
    // CLI authorization releases only CLI-desired managed links; web/mobile links recover by credential and expire through the relay reaper.
    if (
      !(yield* readCliDesiredCloudLink.pipe(withSecrets)) ||
      (yield* readCliDesiredLinkMode.pipe(withSecrets)) !== "managed"
    ) {
      return false;
    }
    // Update handoffs reuse the tunnel: replacing it adds 1-2 minutes of hostname propagation.
    if (
      (yield* withRuntimeFiles(desktopUpdateRestartPending)) ||
      (yield* withRuntimeFiles(pendingUpdateHandoffExists))
    ) {
      yield* Effect.logInfo("Keeping the managed tunnel across the update restart");
      return false;
    }
    const token = yield* cliTokenManager.getExisting;
    if (Option.isNone(token)) {
      return false;
    }
    // Use the persisted relay URL; T3CODE_RELAY_URL may have changed since linking.
    const relayUrl = yield* secrets.get(RELAY_URL_SECRET);
    if (Option.isNone(relayUrl)) {
      return false;
    }
    const environmentId = yield* environment.getEnvironmentId;
    yield* endpointRuntime.applyConfig(null);
    const response = yield* HttpClientRequest.delete(
      `${bytesToString(relayUrl.value)}/v1/client/environment-links/${encodeURIComponent(environmentId)}/tunnel`,
    ).pipe(
      HttpClientRequest.bearerToken(token.value.accessToken),
      httpClient.execute,
      Effect.flatMap(filterRelayResponse),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
      withRelayClientTracing,
    );
    // ok:false means concurrent provisioning owns the tunnel; preserve its config.
    if (!response.ok) {
      return false;
    }
    // Released tokens are dead; remove only this shutdown's config to preserve a fast restart's replacement.
    const storedConfig = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
    if (
      Option.isSome(storedConfig) &&
      bytesToString(storedConfig.value) === bytesToString(runtimeConfig.value)
    ) {
      yield* secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
      yield* secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN);
    }
    return true;
  });

  const readCloudLinkState = Effect.fn("environment.cloud.readLinkState")(function* () {
    const [
      cloudUserId,
      relayUrl,
      relayIssuer,
      endpointRuntimeConfig,
      publishAgentActivity,
      holdWebhooks,
      revoked,
      latestReachability,
    ] = yield* Effect.all(
      [
        secrets.get(CLOUD_LINKED_USER_ID),
        secrets.get(RELAY_URL_SECRET),
        secrets.get(RELAY_ISSUER_SECRET),
        secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
        secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
        secrets.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET),
        secrets.get(CLOUD_LINK_REVOKED),
        reachability.latest,
      ],
      { concurrency: 8 },
    );
    // A not-linked check predates the stored tunnel config; the next check replaces it.
    const currentReachability = Option.filter(
      latestReachability,
      (result) =>
        Option.isNone(endpointRuntimeConfig) ||
        !(result.status === "unreachable" && result.cause === "not_linked"),
    );
    return {
      linked: Option.isSome(cloudUserId),
      linkRevoked: Option.isSome(cloudUserId) && Option.isSome(revoked),
      cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
      relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
      relayIssuer: Option.isSome(relayIssuer) ? bytesToString(relayIssuer.value) : null,
      managedTunnelActive: Option.isSome(endpointRuntimeConfig),
      publishAgentActivity: Option.isSome(publishAgentActivity)
        ? bytesToString(publishAgentActivity.value) === "true"
        : false,
      holdWebhooksWhileOffline:
        Option.isSome(holdWebhooks) && bytesToString(holdWebhooks.value) === "true",
      ...(Option.isSome(currentReachability) ? { reachability: currentReachability.value } : {}),
    } satisfies EnvironmentCloudLinkStateResult;
  });

  return {
    ...state,
    makeManagedTunnelRecoveryProof,
    markLinkRevoked,
    registerManagedTunnelRecovery,
    recoverManagedTunnel,
    applyRelayConfig,
    releaseManagedTunnelOnShutdown,
    readCloudLinkState,
  };
});
