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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { CloudLink } from "./CloudLink.ts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";
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
import * as ManagedLimits from "../policy/managedLimits.ts";
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

import type { makeCloudLinkStage2 } from "./CloudLink-part4.ts";

type State = Effect.Success<ReturnType<typeof makeCloudLinkStage2>>;

export const makeCloudLinkFlows = Effect.fn("makeCloudLinkFlows")(function* (state: State) {
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
    makeManagedTunnelRecoveryProof,
    markLinkRevoked,
    registerManagedTunnelRecovery,
    recoverManagedTunnel,
    applyRelayConfig,
    releaseManagedTunnelOnShutdown,
    readCloudLinkState,
  } = state;
  const linkState = Effect.fn("environment.cloud.linkState")(
    function* () {
      return yield* readCloudLinkState();
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("read-relay-config")),
  );

  const unlink = Effect.fn("environment.cloud.unlink")(
    function* () {
      return yield* endpointRuntime.withLinkStateLock(
        Effect.gen(function* () {
          const endpointRuntimeStatus = yield* endpointRuntime.applyConfig(null);
          yield* Effect.all(
            [
              secrets.remove(CLOUD_LINKED_USER_ID),
              secrets.remove(RELAY_URL_SECRET),
              secrets.remove(RELAY_ISSUER_SECRET),
              secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
              secrets.remove(CLOUD_MINT_PUBLIC_KEY),
              secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
              secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN),
              secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
              secrets.remove(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET),
              secrets.remove(CLOUD_LINK_REVOKED),
            ],
            { concurrency: 10 },
          );
          yield* setCliDesiredCloudLink(false).pipe(withSecrets);
          return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
        }),
      );
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("remove-relay-config")),
  );

  const pushHoldWebhooksWhileOffline = Effect.fn("CloudPreferences.pushHoldWebhooksWhileOffline")(
    function* (holdWebhooksWhileOffline: boolean) {
      const connection = yield* readRelayConnection.pipe(withSecrets);
      if (connection === null) {
        return yield* new CloudLinkNotLinkedError({});
      }
      const environmentId = yield* environment.getEnvironmentId;
      const client = yield* makeRelayEnvironmentClient(connection);
      yield* client.server
        .updateLinkPreferences({
          params: { environmentId },
          payload: { holdWebhooksWhileOffline },
        })
        .pipe(Effect.timeout("10 seconds"), Effect.catch(internalError("update-webhook-settings")));
    },
  );

  const savePreference = (name: string, value: boolean) =>
    secrets
      .set(name, stringToBytes(String(value)))
      .pipe(Effect.catch(internalError("persist-preferences")));

  const preferencesLock = yield* Semaphore.make(1);

  const savePreferences = Effect.fn("CloudPreferences.update")(
    function* (input: EnvironmentCloudPreferencesRequest) {
      // Read rollback targets before changing anything; failed reads must abort.
      const readCurrent = (name: string) =>
        secrets.get(name).pipe(Effect.catch(internalError("read-preferences")));
      const previousActivity = yield* readCurrent(PUBLISH_AGENT_ACTIVITY_SECRET);
      const previousHold = yield* readCurrent(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET);
      yield* savePreference(PUBLISH_AGENT_ACTIVITY_SECRET, input.publishAgentActivity);
      if (input.holdWebhooksWhileOffline !== undefined) {
        const next = input.holdWebhooksWhileOffline;
        const previous = Option.match(previousHold, {
          onNone: () => false,
          onSome: (bytes) => bytesToString(bytes) === "true",
        });
        yield* pushHoldWebhooksWhileOffline(next).pipe(
          Effect.andThen(
            savePreference(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET, next).pipe(
              Effect.tapError(() =>
                previous === next
                  ? Effect.void
                  : pushHoldWebhooksWhileOffline(previous).pipe(Effect.catch(rollbackFailed)),
              ),
            ),
          ),
          Effect.tapError(() =>
            Option.match(previousActivity, {
              onNone: () => secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
              onSome: (bytes) => secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, bytes),
            }).pipe(Effect.catch(rollbackFailed)),
          ),
        );
      }
      yield* awarenessRelay.requestCatchUp();
    },
    // Finish or roll back even if the client disconnects mid-update.
    Effect.uninterruptible,
    preferencesLock.withPermits(1),
  );

  const updatePreferences = Effect.fn("environment.cloud.preferences")(
    function* (input: EnvironmentCloudPreferencesRequest) {
      yield* savePreferences(input);
      return yield* readCloudLinkState();
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("read-preferences")),
  );

  const answerHealthRequest = Effect.fn("environment.cloud.health")(
    function* (request: RelayCloudEnvironmentHealthRequest) {
      const cloudMintPublicKey = yield* secrets
        .get(CLOUD_MINT_PUBLIC_KEY)
        .pipe(
          Effect.flatMap((bytes) =>
            Option.isSome(bytes)
              ? Effect.succeed(bytesToString(bytes.value))
              : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
          ),
        );
      const relayIssuer = yield* secrets
        .get(RELAY_ISSUER_SECRET)
        .pipe(
          Effect.flatMap((bytes) =>
            Option.isSome(bytes)
              ? Effect.succeed(bytesToString(bytes.value))
              : secrets
                  .get(RELAY_URL_SECRET)
                  .pipe(
                    Effect.flatMap((fallbackBytes) =>
                      Option.isSome(fallbackBytes)
                        ? Effect.succeed(bytesToString(fallbackBytes.value))
                        : Effect.fail(
                            new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({}),
                          ),
                    ),
                  ),
          ),
        );
      const environmentId = yield* environment.getEnvironmentId;
      const linkedCloudUserId = yield* readInstalledCloudUserId;
      const now = yield* DateTime.now;
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const proofOption = yield* verifyRelayJwt({
        publicKey: cloudMintPublicKey,
        token: request.proof,
        typ: RELAY_HEALTH_REQUEST_TYP,
        issuer: normalizeRelayIssuer(relayIssuer),
        audience: `t3-env:${environmentId}`,
        nowEpochSeconds: nowSeconds,
      }).pipe(Effect.flatMap(decodeCloudHealthProof), Effect.option);
      if (
        Option.isNone(proofOption) ||
        proofOption.value.environmentId !== environmentId ||
        proofOption.value.sub !== linkedCloudUserId ||
        !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
        !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:status" })
      ) {
        return yield* new CloudLinkProofRejectedError({ request: "health" });
      }
      const proof = proofOption.value;

      const jtiSecretName = `${CLOUD_HEALTH_JTI_PREFIX}${proof.jti}`;
      const nonceSecretName = `${CLOUD_HEALTH_NONCE_PREFIX}${proof.nonce}`;
      const consumedReplayGuards = yield* consumeCloudReplayGuards({
        secrets,
        names: [jtiSecretName, nonceSecretName],
        value: stringToBytes(DateTime.formatIso(now)),
      });
      if (!consumedReplayGuards) {
        return yield* new CloudLinkProofReplayedError({ request: "health" });
      }

      const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
      const descriptor = yield* environment.getDescriptor;
      const responseExpiresAt = DateTime.add(now, { minutes: 5 });
      const responsePayload = {
        iss: `t3-env:${environmentId}`,
        aud: normalizeRelayIssuer(relayIssuer),
        sub: environmentId,
        jti: yield* random.uuidV4(),
        iat: nowSeconds,
        exp: Math.floor(responseExpiresAt.epochMilliseconds / 1_000),
        environmentId,
        requestNonce: proof.nonce,
        status: "online",
        descriptor,
        checkedAt: DateTime.formatIso(now),
      } satisfies RelayEnvironmentHealthResponseProofPayload;
      const responseProof = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: RELAY_HEALTH_RESPONSE_TYP,
        payload: responsePayload,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentAuth.ServerAuthCloudHealthJwtSigningError({
              cause,
            }),
        ),
      );
      return {
        environmentId,
        status: "online",
        descriptor,
        checkedAt: responsePayload.checkedAt,
        proof: responseProof,
      } satisfies RelayEnvironmentHealthResponse;
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("answer-health")),
  );

  const mintCredential = Effect.fn("environment.cloud.mintCredential")(
    function* (request: RelayCloudMintCredentialRequest) {
      const cloudMintPublicKey = yield* secrets
        .get(CLOUD_MINT_PUBLIC_KEY)
        .pipe(
          Effect.flatMap((bytes) =>
            Option.isSome(bytes)
              ? Effect.succeed(bytesToString(bytes.value))
              : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
          ),
        );
      const relayIssuer = yield* secrets
        .get(RELAY_ISSUER_SECRET)
        .pipe(
          Effect.flatMap((bytes) =>
            Option.isSome(bytes)
              ? Effect.succeed(bytesToString(bytes.value))
              : secrets
                  .get(RELAY_URL_SECRET)
                  .pipe(
                    Effect.flatMap((fallbackBytes) =>
                      Option.isSome(fallbackBytes)
                        ? Effect.succeed(bytesToString(fallbackBytes.value))
                        : Effect.fail(
                            new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({}),
                          ),
                    ),
                  ),
          ),
        );
      const environmentId = yield* environment.getEnvironmentId;
      const linkedCloudUserId = yield* readInstalledCloudUserId;
      const now = yield* DateTime.now;
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const proofOption = yield* verifyRelayJwt({
        publicKey: cloudMintPublicKey,
        token: request.proof,
        typ: RELAY_MINT_REQUEST_TYP,
        issuer: normalizeRelayIssuer(relayIssuer),
        audience: `t3-env:${environmentId}`,
        nowEpochSeconds: nowSeconds,
      }).pipe(Effect.flatMap(decodeCloudMintProof), Effect.option);
      if (
        Option.isNone(proofOption) ||
        proofOption.value.environmentId !== environmentId ||
        proofOption.value.sub !== linkedCloudUserId ||
        proofOption.value.cnf.jkt !== proofOption.value.clientProofKeyThumbprint ||
        !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
        !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:connect" })
      ) {
        return yield* new CloudLinkProofRejectedError({ request: "mint" });
      }
      const proof = proofOption.value;

      const jtiSecretName = `${CLOUD_MINT_JTI_PREFIX}${proof.jti}`;
      const nonceSecretName = `${CLOUD_MINT_NONCE_PREFIX}${proof.nonce}`;
      const consumedReplayGuards = yield* consumeCloudReplayGuards({
        secrets,
        names: [jtiSecretName, nonceSecretName],
        value: stringToBytes(DateTime.formatIso(now)),
      });
      if (!consumedReplayGuards) {
        return yield* new CloudLinkProofReplayedError({ request: "mint" });
      }

      const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
      const issued = yield* environmentAuth.createPairingLink({
        scopes: AuthStandardClientScopes,
        subject: "cloud-connect",
        ttl: Duration.minutes(2),
        label: "T3 Connect connect",
        proofKeyThumbprint: proof.clientProofKeyThumbprint,
      });
      const responsePayload = {
        iss: `t3-env:${environmentId}`,
        aud: normalizeRelayIssuer(relayIssuer),
        sub: environmentId,
        jti: yield* random.uuidV4(),
        iat: nowSeconds,
        exp: Math.floor(issued.expiresAt.epochMilliseconds / 1_000),
        environmentId,
        clientProofKeyThumbprint: proof.clientProofKeyThumbprint,
        requestNonce: proof.nonce,
        credential: issued.credential,
      } satisfies RelayEnvironmentMintResponseProofPayload;
      const responseProof = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: RELAY_MINT_RESPONSE_TYP,
        payload: responsePayload,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentAuth.ServerAuthCloudMintJwtSigningError({
              cause,
            }),
        ),
      );
      return {
        credential: issued.credential,
        expiresAt: DateTime.formatIso(issued.expiresAt),
        proof: responseProof,
      } satisfies RelayEnvironmentMintResponse;
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("issue-credential")),
  );

  if (!ManagedLimits.allowsConnect(managedPolicy)) {
    // Reading state and unlinking stay available so clients can show and leave the old link.
    yield* unlink().pipe(
      Effect.tap(() => Effect.logInfo("T3 Connect is off by managed policy; unlinked.")),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to unlink T3 Connect turned off by managed policy", { cause }),
      ),
    );
    const refused = Effect.fn("CloudLink.refusedByPolicy")(function* () {
      return yield* ManagedLimits.refuseConnect(managedPolicy);
    });
    const notLinked = Effect.fn("CloudLink.notLinkedByPolicy")(() =>
      Effect.succeed({ status: "not_linked" as const }),
    );
    const notDesired = Effect.fn("CloudLink.notDesiredByPolicy")(() => Effect.succeed(null));
    const notStarted = Effect.fn("CloudLink.notStartedByPolicy")(() => Effect.succeed(false));
    return CloudLink.of({
      linkProof: refused,
      applyRelayConfig: refused,
      linkState,
      unlink,
      updatePreferences: refused,
      answerHealthRequest: refused,
      mintCredential: refused,
      reconcileDesiredLinkIfStillDesired: notDesired,
      registerManagedTunnelRecovery: notLinked,
      recoverManagedTunnel: notStarted,
      startManagedTunnelIfOriginConfirmed: notStarted,
      releaseManagedTunnelOnShutdown,
    });
  }

  return {
    linkProof,
    applyRelayConfig,
    linkState,
    unlink,
    updatePreferences,
    answerHealthRequest,
    mintCredential,
    reconcileDesiredLinkIfStillDesired,
    registerManagedTunnelRecovery,
    recoverManagedTunnel,
    startManagedTunnelIfOriginConfirmed,
    releaseManagedTunnelOnShutdown,
  };
});
