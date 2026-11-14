// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createPublicKey.
import * as NodeCrypto from "node:crypto";
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
import { isSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpServerRequest,
} from "effect/http";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpServer from "effect/http/HttpServer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
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
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { relayUrlConfig } from "./publicConfig.ts";
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

import { makeCloudLinkState } from "./CloudLink-part3.ts";
import { makeCloudLinkStage2 } from "./CloudLink-part4.ts";
import { makeCloudLinkFlows } from "./CloudLink-part5.ts";

export class CloudLink extends Context.Service<
  CloudLink,
  {
    /**
     * Signs the proof the relay asks for to link this environment. The request
     * must reach this server directly. Desktop bootstrap sessions may use the
     * WSL IP; all other sessions must use the loopback origin they name.
     */
    readonly linkProof: (
      request: RelayLinkProofRequest,
      httpRequest: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      RelayEnvironmentLinkProof,
      | CloudLinkOriginInvalidError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError,
      EnvironmentAuthenticatedPrincipal
    >;
    readonly applyRelayConfig: (
      payload: RelayEnvironmentConfigRequest,
    ) => Effect.Effect<
      EnvironmentCloudRelayConfigResult,
      | CloudLinkAccountMismatchError
      | CloudLinkEndpointUnavailableError
      | CloudLinkInternalError
      | CloudLinkOriginInvalidError
      | CloudLinkRelayConfigInvalidError
      | CloudLinkTunnelSupersededError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
      | RelayRequestError
    >;
    readonly linkState: () => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      CloudLinkInternalError
    >;
    readonly unlink: () => Effect.Effect<EnvironmentCloudRelayConfigResult, CloudLinkInternalError>;
    readonly updatePreferences: (
      input: EnvironmentCloudPreferencesRequest,
    ) => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      CloudLinkNotLinkedError | CloudLinkInternalError | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly answerHealthRequest: (
      request: RelayCloudEnvironmentHealthRequest,
    ) => Effect.Effect<
      RelayEnvironmentHealthResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly mintCredential: (
      request: RelayCloudMintCredentialRequest,
    ) => Effect.Effect<
      RelayEnvironmentMintResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
    >;
    readonly reconcileDesiredLinkIfStillDesired: (
      localOrigin: string,
    ) => Effect.Effect<
      CliDesiredLinkMode | null,
      | CloudLinkBackgroundError
      | CloudLinkAccountMismatchError
      | CloudLinkAuthorizationMissingError
      | CloudLinkRelayConfigInvalidError
      | EnvironmentAuth.ServerAuthInternalError
      | CliTokenManager.CloudCliTokenManagerError
    >;
    readonly registerManagedTunnelRecovery: (
      localOrigin: string,
      options?: { readonly retryRuntimeFailures?: boolean },
    ) => Effect.Effect<ManagedTunnelRegistration, CloudLinkBackgroundError>;
    readonly recoverManagedTunnel: (
      localOrigin: string,
      expectedConfig?: RelayManagedEndpointRuntimeConfig,
      options?: { readonly retryRuntimeFailures?: boolean },
    ) => Effect.Effect<boolean, CloudLinkBackgroundError>;
    readonly startManagedTunnelIfOriginConfirmed: (
      localOrigin: string,
      options?: { readonly requireConfirmedOrigin?: boolean },
    ) => Effect.Effect<
      boolean,
      | CloudLinkEndpointUnavailableError
      | CloudLinkOriginInvalidError
      | ServerSecretStore.SecretStoreError
    >;
    readonly releaseManagedTunnelOnShutdown: () => Effect.Effect<
      boolean,
      | CloudLinkBackgroundError
      | CliTokenManager.CloudCliTokenManagerError
      | HttpClientError.HttpClientError
    >;
  }
>()("t3/cloud/CloudLink") {}

const make = Effect.gen(function* () {
  const s1 = yield* makeCloudLinkState();
  const s2 = yield* makeCloudLinkStage2(s1);
  const s3 = yield* makeCloudLinkFlows(s2);
  const shape = s3;
  return CloudLink.of(shape);
});

export const layer = Layer.effect(CloudLink, make);
export * from "./CloudLink-part2.ts";

