import {
  type EnvironmentCloudLinkStateResult,
  type EnvironmentCloudPreferencesRequest,
  type EnvironmentCloudRelayConfigResult,
} from "@t3tools/contracts";
import {
  type RelayCloudEnvironmentHealthRequest,
  type RelayCloudMintCredentialRequest,
  type RelayEnvironmentConfigRequest,
  type RelayEnvironmentHealthResponse,
  type RelayEnvironmentLinkProof,
  type RelayEnvironmentMintResponse,
  type RelayLinkProofRequest,
  type RelayManagedEndpointRuntimeConfig,
  type RelayOkResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type * as HttpClientError from "effect/http/HttpClientError";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { CliDesiredLinkMode } from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import type * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import type * as ManagedLimits from "../policy/managedLimits.ts";
import { type RelayRequestError, shouldRetryRelayRequest } from "./relayResponse.ts";

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
export const CLOUD_REPLAY_MARKER_PREFIXES = [
  CLOUD_MINT_NONCE_PREFIX,
  CLOUD_MINT_JTI_PREFIX,
  CLOUD_HEALTH_NONCE_PREFIX,
  CLOUD_HEALTH_JTI_PREFIX,
] as const;
const RELAY_CONFIG_FIELD_MESSAGES = {
  relayUrl: "Relay URL must be a secure absolute HTTPS URL.",
  relayIssuer: "Relay issuer must be a secure absolute HTTPS URL.",
  environmentCredential: "Relay environment credential is required.",
  cloudUserId: "Cloud user id is required.",
  cloudMintPublicKey: "Cloud mint public key must be a valid Ed25519 public key.",
} as const;

export class CloudLinkRelayConfigInvalidError extends Schema.TaggedError<CloudLinkRelayConfigInvalidError>()(
  "CloudLinkRelayConfigInvalidError",
  {
    field: Schema.Literals([
      "relayUrl",
      "relayIssuer",
      "environmentCredential",
      "cloudUserId",
      "cloudMintPublicKey",
    ]),
  },
) {
  override get message(): string {
    return RELAY_CONFIG_FIELD_MESSAGES[this.field];
  }
}

export class CloudLinkOriginInvalidError extends Schema.TaggedError<CloudLinkOriginInvalidError>()(
  "CloudLinkOriginInvalidError",
  { origin: Schema.Literals(["endpoint", "local"]) },
) {
  override get message(): string {
    return this.origin === "endpoint"
      ? "Invalid managed endpoint origin."
      : "Could not resolve local environment origin.";
  }
}

export class CloudLinkNotLinkedError extends Schema.TaggedError<CloudLinkNotLinkedError>()(
  "CloudLinkNotLinkedError",
  {},
) {
  override get message(): string {
    return "Link this environment to T3 Connect first.";
  }
}

export class CloudLinkAccountMismatchError extends Schema.TaggedError<CloudLinkAccountMismatchError>()(
  "CloudLinkAccountMismatchError",
  {},
) {
  override get message(): string {
    return "This environment is already linked to a different cloud account. Unlink it before switching accounts.";
  }
}

export class CloudLinkAuthorizationMissingError extends Schema.TaggedError<CloudLinkAuthorizationMissingError>()(
  "CloudLinkAuthorizationMissingError",
  {},
) {
  override get message(): string {
    return "Run `tix connect link` to authorize this environment.";
  }
}

const SignedRelayRequest = Schema.Literals(["health", "mint"]);

export class CloudLinkProofRejectedError extends Schema.TaggedError<CloudLinkProofRejectedError>()(
  "CloudLinkProofRejectedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Invalid cloud ${this.request} request.`;
  }
}

export class CloudLinkProofReplayedError extends Schema.TaggedError<CloudLinkProofReplayedError>()(
  "CloudLinkProofReplayedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Cloud ${this.request} request was already consumed.`;
  }
}

export class CloudLinkTunnelSupersededError extends Schema.TaggedError<CloudLinkTunnelSupersededError>()(
  "CloudLinkTunnelSupersededError",
  {},
) {
  override get message(): string {
    return "The managed tunnel configuration changed during registration.";
  }
}

export class CloudLinkEndpointUnavailableError extends Schema.TaggedError<CloudLinkEndpointUnavailableError>()(
  "CloudLinkEndpointUnavailableError",
  {
    reason: Schema.Literals(["runtime-not-started", "origin-unconfirmed"]),
    endpointRuntimeStatus: Schema.Unknown,
  },
) {
  override get message(): string {
    return this.reason === "runtime-not-started"
      ? "Managed endpoint runtime could not be started."
      : "Managed endpoint origin could not be confirmed.";
  }
}

const INTERNAL_OPERATION_MESSAGES = {
  "relay-url-unconfigured":
    "T3CODE_RELAY_URL must be configured as a secure absolute HTTPS origin.",
  "generate-link-proof": "Could not generate environment link proof.",
  "persist-relay-config": "Could not persist environment relay configuration.",
  "register-endpoint-origin": "Could not register the managed endpoint origin.",
  "resolve-server-origin": "Could not resolve the local server origin.",
  "persist-desired-link": "Could not persist desired T3 Connect link state.",
  "sign-recovery-proof": "Could not sign the managed tunnel recovery request.",
  "unsupported-recovered-tunnel":
    "T3 Connect returned an unsupported managed tunnel configuration.",
  "persist-recovered-tunnel": "Could not persist the recovered managed tunnel configuration.",
  "read-relay-config": "Could not read environment relay configuration.",
  "remove-relay-config": "Could not remove environment relay configuration.",
  "update-live-activity-preference": "Could not update T3 Connect Live Activity preferences.",
  "update-webhook-settings": "Could not update T3 Connect webhook settings.",
  "read-preferences": "Could not read environment cloud preferences.",
  "persist-preferences": "Could not persist environment cloud preferences.",
  "answer-health": "Could not answer cloud health request.",
  "issue-credential": "Could not issue cloud connection credential.",
} as const;

export class CloudLinkInternalError extends Schema.TaggedError<CloudLinkInternalError>()(
  "CloudLinkInternalError",
  {
    operation: Schema.Literals(
      Object.keys(INTERNAL_OPERATION_MESSAGES) as [
        keyof typeof INTERNAL_OPERATION_MESSAGES,
        ...Array<keyof typeof INTERNAL_OPERATION_MESSAGES>,
      ],
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return INTERNAL_OPERATION_MESSAGES[this.operation];
  }
}

const isPermanentLinkError = Schema.is(
  Schema.Union([
    CloudLinkRelayConfigInvalidError,
    CloudLinkOriginInvalidError,
    CloudLinkNotLinkedError,
    CloudLinkAccountMismatchError,
    CloudLinkAuthorizationMissingError,
    CloudLinkProofRejectedError,
    CloudLinkProofReplayedError,
    CloudLinkTunnelSupersededError,
  ]),
);

export const shouldRetryCloudLink = (error: unknown): boolean =>
  shouldRetryRelayRequest(error) &&
  !isPermanentLinkError(error) &&
  !(CliTokenManager.isCloudCliCredentialRefreshError(error) && error.requiresLogin);

export type CloudLinkError =
  | CloudLinkAccountMismatchError
  | CloudLinkAuthorizationMissingError
  | CloudLinkEndpointUnavailableError
  | CloudLinkInternalError
  | CloudLinkNotLinkedError
  | CloudLinkOriginInvalidError
  | CloudLinkProofRejectedError
  | CloudLinkProofReplayedError
  | CloudLinkRelayConfigInvalidError
  | CloudLinkTunnelSupersededError;

type CloudLinkBackgroundError =
  | CloudLinkEndpointUnavailableError
  | CloudLinkInternalError
  | CloudLinkOriginInvalidError
  | RelayRequestError
  | ServerSecretStore.SecretStoreError
  | Schema.SchemaError
  | PlatformError.PlatformError;

type ManagedTunnelRegistration =
  | { readonly status: "not_linked" | "superseded" | "revoked" }
  | { readonly status: "recovery_required"; readonly config: RelayManagedEndpointRuntimeConfig }
  | {
      readonly status: "ready";
      readonly endpointRuntimeStatus: ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus;
    };

export class CloudLink extends Context.Service<
  CloudLink,
  {
    /** Signs the proof the relay asks for to link this environment, for this server's own origin. */
    readonly linkProof: (
      request: RelayLinkProofRequest,
    ) => Effect.Effect<
      RelayEnvironmentLinkProof,
      | CloudLinkOriginInvalidError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
      | ManagedLimits.ManagedPolicyRefusedError
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
    readonly updateLiveActivityPreference: (
      enabled: boolean,
    ) => Effect.Effect<
      RelayOkResponse,
      CloudLinkInternalError | ManagedLimits.ManagedPolicyRefusedError
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

const cloudDisabledError = (operation: string) =>
  new CloudLinkInternalError({ operation, cause: "T3 Connect is disabled in this build" });

const unlinkedState: EnvironmentCloudLinkStateResult = {
  linked: false,
  cloudUserId: null,
  relayUrl: null,
  relayIssuer: null,
  linkedAt: null,
  revoked: false,
  holdWebhooksWhileOffline: false,
  liveActivitiesEnabled: false,
  managedEndpoint: null,
};

const unlinkedConfigResult: EnvironmentCloudRelayConfigResult = {
  linked: false,
  relayUrl: null,
  relayIssuer: null,
  linkedAt: null,
};

const make = Effect.succeed(
  CloudLink.of({
    linkProof: () => Effect.fail(cloudDisabledError("link-proof")),
    applyRelayConfig: () => Effect.fail(cloudDisabledError("apply-relay-config")),
    linkState: () => Effect.succeed(unlinkedState),
    unlink: () => Effect.succeed(unlinkedConfigResult),
    updatePreferences: () => Effect.fail(new CloudLinkNotLinkedError({})),
    updateLiveActivityPreference: () => Effect.succeed({ ok: false }),
    answerHealthRequest: () => Effect.fail(cloudDisabledError("answer-health-request")),
    mintCredential: () => Effect.fail(cloudDisabledError("mint-credential")),
    reconcileDesiredLinkIfStillDesired: () => Effect.succeed(null),
    registerManagedTunnelRecovery: () => Effect.succeed({ status: "none" }),
    recoverManagedTunnel: () => Effect.succeed(false),
    startManagedTunnelIfOriginConfirmed: () => Effect.succeed(false),
    releaseManagedTunnelOnShutdown: () => Effect.succeed(false),
  }),
);

export const layer = Layer.effect(CloudLink, make);
