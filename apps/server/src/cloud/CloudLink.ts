/**
 * The T3 Connect link lifecycle of this environment: linking it to the relay,
 * applying and reading the link, unlinking, answering the relay's signed health
 * and mint requests, and keeping the managed tunnel registered, recovered and
 * released. HTTP handlers, server startup and shutdown all go through it.
 */
import * as NodeCrypto from "node:crypto";
import {
  AuthStandardClientScopes,
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
import * as Crypto from "effect/Crypto";
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
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
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

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
/** Secret store name prefixes of cloud replay markers. The server prunes expired ones. */
export const CLOUD_REPLAY_MARKER_PREFIXES = [
  CLOUD_MINT_NONCE_PREFIX,
  CLOUD_MINT_JTI_PREFIX,
  CLOUD_HEALTH_NONCE_PREFIX,
  CLOUD_HEALTH_JTI_PREFIX,
] as const;
const MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT = Duration.minutes(2);
const RELAY_CONFIG_FIELD_MESSAGES = {
  relayUrl: "Relay URL must be a secure absolute HTTPS URL.",
  relayIssuer: "Relay issuer must be a secure absolute HTTPS URL.",
  environmentCredential: "Relay environment credential is required.",
  cloudUserId: "Cloud user id is required.",
  cloudMintPublicKey: "Cloud mint public key must be a valid Ed25519 public key.",
} as const;

/** The relay sent a link configuration this environment cannot install. */
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

/**
 * A link was asked to point at an origin it may not serve: a link proof request
 * that did not reach this server directly on loopback (`endpoint`), or a local
 * origin that is not a bare http(s) origin (`local`).
 */
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

/** Linking from the CLI needs the authorization `t3 connect link` stores. */
export class CloudLinkAuthorizationMissingError extends Schema.TaggedError<CloudLinkAuthorizationMissingError>()(
  "CloudLinkAuthorizationMissingError",
  {},
) {
  override get message(): string {
    return "Run `t3 connect link` to authorize this environment.";
  }
}

const SignedRelayRequest = Schema.Literals(["health", "mint"]);

/** A signed relay request whose proof does not verify for this environment. */
export class CloudLinkProofRejectedError extends Schema.TaggedError<CloudLinkProofRejectedError>()(
  "CloudLinkProofRejectedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Invalid cloud ${this.request} request.`;
  }
}

/** A signed relay request whose proof was already used once. */
export class CloudLinkProofReplayedError extends Schema.TaggedError<CloudLinkProofReplayedError>()(
  "CloudLinkProofReplayedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Cloud ${this.request} request was already consumed.`;
  }
}

/** The stored tunnel changed while its registration was in flight. */
export class CloudLinkTunnelSupersededError extends Schema.TaggedError<CloudLinkTunnelSupersededError>()(
  "CloudLinkTunnelSupersededError",
  {},
) {
  override get message(): string {
    return "The managed tunnel configuration changed during registration.";
  }
}

/**
 * The managed tunnel is not serving: its connector did not start
 * (`runtime-not-started`, with the runtime's status), or the relay never
 * confirmed this server's origin (`origin-unconfirmed`).
 */
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
  "update-webhook-settings": "Could not update T3 Connect webhook settings.",
  "read-preferences": "Could not read environment cloud preferences.",
  "persist-preferences": "Could not persist environment cloud preferences.",
  "answer-health": "Could not answer cloud health request.",
  "issue-credential": "Could not issue cloud connection credential.",
} as const;

/** A link step failed on this machine: storage, signing, or an unexpected relay answer. */
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

const internalError =
  (operation: CloudLinkInternalError["operation"]) =>
  (cause: unknown): Effect.Effect<never, CloudLinkInternalError> =>
    Effect.fail(new CloudLinkInternalError({ operation, cause }));

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

/** Whether a failed link step may succeed on retry: not when the relay or this server refused it. */
export const shouldRetryCloudLink = (error: unknown): boolean =>
  shouldRetryRelayRequest(error) && !isPermanentLinkError(error);

/** A failed rollback leaves a setting changed; it is logged, not hidden. */
const rollbackFailed = (cause: unknown) =>
  Effect.logWarning("Could not roll back a T3 Connect preference", { cause });

const requireRelayUrl = relayUrlConfig.pipe(
  Effect.mapError(
    (cause) => new CloudLinkInternalError({ operation: "relay-url-unconfigured", cause }),
  ),
);

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Records each one-shot marker; false when any already existed, so the request is a replay. */
export function consumeCloudReplayGuards(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.forEach(
    input.names,
    (name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      ),
    { concurrency: input.names.length },
  ).pipe(Effect.map((created) => created.every(Boolean)));
}

function validateCloudMintPublicKey(
  publicKey: string,
): Effect.Effect<void, CloudLinkRelayConfigInvalidError> {
  const invalid = new CloudLinkRelayConfigInvalidError({ field: "cloudMintPublicKey" });
  return Effect.try({
    try: () => NodeCrypto.createPublicKey(publicKey.replace(/\\n/g, "\n")),
    catch: () => invalid,
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519" ? Effect.void : Effect.fail(invalid),
    ),
  );
}

function invalidRelayConfigField(
  payload: RelayEnvironmentConfigRequest,
): CloudLinkRelayConfigInvalidError["field"] | null {
  if (!isSecureRelayUrl(payload.relayUrl)) return "relayUrl";
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return "relayIssuer";
  }
  if (payload.environmentCredential.trim().length === 0) return "environmentCredential";
  if (payload.cloudUserId.trim().length === 0) return "cloudUserId";
  return null;
}

function validateRelayConfigPayload(
  payload: RelayEnvironmentConfigRequest,
): Effect.Effect<void, CloudLinkRelayConfigInvalidError> {
  const field = invalidRelayConfigField(payload);
  return field === null
    ? Effect.void
    : Effect.fail(new CloudLinkRelayConfigInvalidError({ field }));
}

function normalizePemForSignedPayload(value: string): string {
  return value.trim();
}

const decodeCloudHealthProof = Schema.decodeUnknownEffect(RelayCloudEnvironmentHealthProofPayload);
const decodeCloudMintProof = Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload);

type ManagedTunnelRecoveryProofInput = {
  readonly environmentId: RelayManagedEndpointRecoveryProofPayload["environmentId"];
  readonly cloudUserId: string;
  readonly relayUrl: string;
} & (
  | {
      readonly action: "register";
      readonly tunnelId: string;
      readonly origin: RelayManagedEndpointOrigin;
    }
  | { readonly action: "recover"; readonly origin: RelayManagedEndpointOrigin }
);

/** Every failure CloudLink constructs itself. */
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

/** Failures of the link work that talks to the relay: linking, recovery and shutdown. */
type CloudLinkBackgroundError =
  | CloudLinkEndpointUnavailableError
  | CloudLinkInternalError
  | CloudLinkOriginInvalidError
  | RelayRequestError
  | ServerSecretStore.SecretStoreError
  | Schema.SchemaError
  | PlatformError.PlatformError;

type ManagedTunnelRegistration =
  | { readonly status: "not_linked" | "superseded" }
  | { readonly status: "recovery_required"; readonly config: RelayManagedEndpointRuntimeConfig }
  | {
      readonly status: "ready";
      readonly endpointRuntimeStatus: ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus;
    };

export class CloudLink extends Context.Service<
  CloudLink,
  {
    /**
     * Signs the proof the relay asks for to link this environment. The request
     * must reach this server directly on the loopback origin it names.
     */
    readonly linkProof: (
      request: RelayLinkProofRequest,
      httpRequest: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      RelayEnvironmentLinkProof,
      CloudLinkOriginInvalidError | CloudLinkInternalError | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Installs the link the relay returned and, for a managed tunnel, confirms its origin. */
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
      | RelayRequestError
    >;
    readonly linkState: () => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      CloudLinkInternalError
    >;
    /** Stops the tunnel and forgets the link, including the CLI's wish to keep it. */
    readonly unlink: () => Effect.Effect<EnvironmentCloudRelayConfigResult, CloudLinkInternalError>;
    /**
     * Saves this environment's T3 Connect preferences, all or nothing, and
     * returns the link state. The activity setting is saved first. Holding
     * webhooks while offline is decided by the relay, so the relay is told
     * before the local copy is saved. If either step fails, the activity
     * setting is put back, and so is the relay when only the local save failed.
     */
    readonly updatePreferences: (
      input: EnvironmentCloudPreferencesRequest,
    ) => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      CloudLinkNotLinkedError | CloudLinkInternalError
    >;
    /** Answers the relay's signed health check once per proof. */
    readonly answerHealthRequest: (
      request: RelayCloudEnvironmentHealthRequest,
    ) => Effect.Effect<
      RelayEnvironmentHealthResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Issues a short-lived pairing credential for a client the relay vouched for, once per proof. */
    readonly mintCredential: (
      request: RelayCloudMintCredentialRequest,
    ) => Effect.Effect<
      RelayEnvironmentMintResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Links this environment with the stored CLI authorization and records the CLI's wish. */
    readonly reconcileDesiredLink: (
      localOrigin: string,
    ) => Effect.Effect<
      CliDesiredLinkMode,
      | CloudLinkBackgroundError
      | CloudLinkAccountMismatchError
      | CloudLinkAuthorizationMissingError
      | CloudLinkRelayConfigInvalidError
      | EnvironmentAuth.ServerAuthInternalError
      | CliTokenManager.CloudCliTokenManagerError
    >;
    /** As `reconcileDesiredLink`, but returns null when the CLI no longer wants a link. */
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
    /** Tells the relay which local origin the stored tunnel serves, then starts it. */
    readonly registerManagedTunnelRecovery: (
      localOrigin: string,
      options?: { readonly retryRuntimeFailures?: boolean },
    ) => Effect.Effect<ManagedTunnelRegistration, CloudLinkBackgroundError>;
    /** Asks the relay for a replacement tunnel, unless the stored one changed meanwhile. */
    readonly recoverManagedTunnel: (
      localOrigin: string,
      expectedConfig?: RelayManagedEndpointRuntimeConfig,
      options?: { readonly retryRuntimeFailures?: boolean },
    ) => Effect.Effect<boolean, CloudLinkBackgroundError>;
    /**
     * Starts the stored tunnel. By default only one the relay already confirmed
     * on this origin; startup falls back to any stored tunnel when the relay
     * stays unreachable.
     */
    readonly startManagedTunnelIfOriginConfirmed: (
      localOrigin: string,
      options?: { readonly requireConfirmedOrigin?: boolean },
    ) => Effect.Effect<
      boolean,
      | CloudLinkEndpointUnavailableError
      | CloudLinkOriginInvalidError
      | ServerSecretStore.SecretStoreError
    >;
    /** Deletes a CLI-managed tunnel when this server goes offline for good. */
    readonly releaseManagedTunnelOnShutdown: () => Effect.Effect<
      boolean,
      | CloudLinkBackgroundError
      | CliTokenManager.CloudCliTokenManagerError
      | HttpClientError.HttpClientError
    >;
  }
>()("t3/cloud/CloudLink") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const endpointRuntime = yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const cliTokenManager = yield* CliTokenManager.CloudCliTokenManager;
  const httpClient = yield* HttpClient.HttpClient;
  const httpServer = yield* HttpServer.HttpServer;
  const awarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

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
  ) {
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
    if (
      !isSupportedLinkProviderKind(request) ||
      !isAllowedEndpointOrigin({
        origin: request.origin,
        requestUrl,
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
      jti: yield* crypto.randomUUIDv4,
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
      const proof = yield* makeCloudLinkProof(request, requestUrl);
      return proof satisfies RelayEnvironmentLinkProof;
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("generate-link-proof")),
    Effect.catchTags({ PlatformError: internalError("generate-link-proof") }),
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
        // With the marker required, only a config the relay already confirmed on
        // this port may start. Without it, startup is falling back after the
        // relay stayed unreachable: an unconfirmed origin may send traffic to a
        // stale port, but that beats no remote access at all.
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
      // Reject unsupported runtimes before touching the connector so a bad
      // payload cannot stop a healthy tunnel on its way to a 503.
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
      yield* endpointRuntime.applyConfig(null);
      yield* secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN);

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
      yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, stringToBytes(payload.cloudMintPublicKey));
      yield* awarenessRelay.requestCatchUp();
      if (payload.endpointRuntime) {
        const endpointRuntimeJson = yield* encodeEndpointRuntimeConfigJson(payload.endpointRuntime);
        yield* secrets.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, stringToBytes(endpointRuntimeJson));
      } else {
        yield* secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
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
      // Callers decide on managed tunnel recovery from the mode this link
      // actually used, not from a value read before the relay round trip.
      return mode;
    },
    Effect.catchIf(ServerSecretStore.isSecretStoreError, internalError("persist-desired-link")),
  );

  const reconcileDesiredLink = Effect.fn("environment.cloud.reconcileDesiredLink")(function* (
    localOrigin: string,
  ) {
    return yield* endpointRuntime.withLinkStateLock(reconcileDesiredCloudLinkWith(localOrigin));
  });

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
      jti: yield* crypto.randomUUIDv4,
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
    const registered = yield* relayClientRequest({
      url: `${relayUrlValue}/v1/environments/${encodeURIComponent(environmentId)}/tunnel/recovery`,
      token: bytesToString(environmentCredential.value),
      payload: {
        cloudUserId: cloudUserIdValue,
        tunnelId: config.tunnelId,
        origin,
        proof,
      },
      schema: RelayManagedEndpointRecoveryRegistrationResponse,
    });
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
    const recovered = yield* relayClientRequest({
      url: `${relayUrlValue}/v1/environments/${encodeURIComponent(environmentId)}/tunnel`,
      token: bytesToString(environmentCredential.value),
      payload: {
        cloudUserId: cloudUserIdValue,
        origin,
        proof,
      },
      schema: RelayManagedEndpointRecoveryResponse,
      timeout: MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT,
    });
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
          `http://127.0.0.1:${address.port}`,
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
      PlatformError: internalError("register-endpoint-origin"),
    }),
  );

  // Cloudflare bills per provisioned tunnel, so an environment that goes offline
  // must not leave its tunnel behind. Releasing deletes only the tunnel — the
  // relay keeps the link and its hostname reservation, and the next startup's
  // link reconcile provisions a replacement tunnel under the same URL.
  const releaseManagedTunnelOnShutdown = Effect.fn(
    "environment.cloud.releaseManagedTunnelOnShutdown",
  )(function* () {
    // Only a managed link stores a runtime config; publish-only links have no
    // tunnel to release.
    const runtimeConfig = yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG);
    if (Option.isNone(runtimeConfig)) {
      return false;
    }
    // Only CLI-desired managed links release eagerly because this request uses
    // CLI authorization. Web/mobile links register startup recovery with their
    // environment credential, and the relay reaper removes them after they are
    // down for the configured grace period. Unlink still deletes either kind.
    if (
      !(yield* readCliDesiredCloudLink.pipe(withSecrets)) ||
      (yield* readCliDesiredLinkMode.pipe(withSecrets)) !== "managed"
    ) {
      return false;
    }
    // A shutdown that hands off to a pending update is not the environment
    // going offline: the service launcher or the desktop app immediately brings
    // a server back (the new version, or the old one after a rollback). Deleting
    // the tunnel here forces that server to provision a replacement UUID, and the
    // public hostname's route to the new tunnel takes 1-2 minutes to propagate —
    // the dominant cost of an update restart. Keep the tunnel instead: the next
    // boot respawns the connector from the stored config and is reachable as
    // soon as it connects, and the reconcile confirms the still-live tunnel
    // without replacing it.
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
    // The link belongs to the relay it was installed against, so target the
    // persisted URL: T3CODE_RELAY_URL may have changed since the link was made.
    const relayUrl = yield* secrets.get(RELAY_URL_SECRET);
    if (Option.isNone(relayUrl)) {
      return false;
    }
    const environmentId = yield* environment.getEnvironmentId;
    // Stop the local connector before the relay deletes the tunnel it serves.
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
    // ok:false means the relay skipped deletion because a concurrent provision
    // owns the recorded tunnel now — leave the stored config alone.
    if (!response.ok) {
      return false;
    }
    // The connector token died with the tunnel. Drop the stored config so the
    // next start waits for the link reconcile instead of respawning the relay
    // client with a dead token. Kept when the release request fails: the tunnel
    // still exists, so the stored token keeps working across the restart.
    // Only dropped while it is still the config this shutdown released — a fast
    // restart may already have reconciled and stored a fresh config for its
    // replacement tunnel, and that one must survive this finalizer.
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
    ] = yield* Effect.all(
      [
        secrets.get(CLOUD_LINKED_USER_ID),
        secrets.get(RELAY_URL_SECRET),
        secrets.get(RELAY_ISSUER_SECRET),
        secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
        secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
        secrets.get(HOLD_WEBHOOKS_WHILE_OFFLINE_SECRET),
      ],
      { concurrency: 6 },
    );
    return {
      linked: Option.isSome(cloudUserId),
      cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
      relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
      relayIssuer: Option.isSome(relayIssuer) ? bytesToString(relayIssuer.value) : null,
      // The managed tunnel runtime config is only stored for managed links; a
      // publish-only link leaves it absent.
      managedTunnelActive: Option.isSome(endpointRuntimeConfig),
      publishAgentActivity: Option.isSome(publishAgentActivity)
        ? bytesToString(publishAgentActivity.value) === "true"
        : false,
      holdWebhooksWhileOffline:
        Option.isSome(holdWebhooks) && bytesToString(holdWebhooks.value) === "true",
    } satisfies EnvironmentCloudLinkStateResult;
  });

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
            ],
            { concurrency: 9 },
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

  // One update at a time, so two requests can't each leave one setting behind.
  const preferencesLock = yield* Semaphore.make(1);

  const savePreferences = Effect.fn("CloudPreferences.update")(
    function* (input: EnvironmentCloudPreferencesRequest) {
      // All or nothing: the activity setting is saved first, before the relay
      // is told anything, and put back if the hold change then fails. Both
      // current values are read up front; a failed read stops here, before
      // anything changes, because a guessed value would be the rollback target.
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
    // A client that disconnects mid-update must not stop it between a save and
    // its rollback, so an update always finishes or undoes itself.
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
        jti: yield* crypto.randomUUIDv4,
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
    Effect.catchTags({ PlatformError: internalError("answer-health") }),
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
        jti: yield* crypto.randomUUIDv4,
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
    Effect.catchTags({ PlatformError: internalError("issue-credential") }),
  );

  return CloudLink.of({
    linkProof,
    applyRelayConfig,
    linkState,
    unlink,
    updatePreferences,
    answerHealthRequest,
    mintCredential,
    reconcileDesiredLink,
    reconcileDesiredLinkIfStillDesired,
    registerManagedTunnelRecovery,
    recoverManagedTunnel,
    startManagedTunnelIfOriginConfirmed,
    releaseManagedTunnelOnShutdown,
  });
});

export const layer = Layer.effect(CloudLink, make);
