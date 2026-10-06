/**
 * The T3 Connect link lifecycle of this environment: linking it to the relay,
 * applying and reading the link, unlinking, answering the relay's signed health
 * and mint requests, and keeping the managed tunnel registered, recovered and
 * released. HTTP handlers, server startup and shutdown all go through it.
 */
import * as NodeCrypto from "node:crypto";
import {
  AuthStandardClientScopes,
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  EnvironmentCloudEndpointUnavailableError,
  type EnvironmentCloudLinkStateResult,
  type EnvironmentCloudPreferencesRequest,
  type EnvironmentCloudRelayConfigResult,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  type EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
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
import * as Clock from "effect/Clock";
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
import { filterRelayResponse, relayRequestError, shouldRetryCloudLink } from "./relayResponse.ts";
import {
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  serviceStateHasPendingUpdate,
} from "./serviceProtocol.ts";

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
const CLOUD_PROOF_MAX_LIFETIME_SECONDS = 5 * 60;
const CLOUD_PROOF_CLOCK_SKEW_SECONDS = 60;
// The desktop app stops its backends within seconds of writing the marker.
const DESKTOP_UPDATE_RESTART_MARKER_TTL = Duration.minutes(1);
const MANAGED_ENDPOINT_PROVISION_REQUEST_TIMEOUT = Duration.minutes(2);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

const failEnvironmentCloudInternalError =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, EnvironmentHttpInternalServerError> =>
    Effect.logError(message, { cause }).pipe(
      Effect.flatMap(() => Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
    );

const failCloudCliTokenManagerError = (error: CliTokenManager.CloudCliTokenManagerError) =>
  failEnvironmentCloudInternalError(error.message)(error);

/** A failed rollback leaves a setting changed; it is logged, not hidden. */
const rollbackFailed = (cause: unknown) =>
  Effect.logWarning("Could not roll back a T3 Connect preference", { cause });

const requireRelayUrl = relayUrlConfig.pipe(
  Effect.mapError(
    () =>
      new EnvironmentHttpInternalServerError({
        message: "T3CODE_RELAY_URL must be configured as a secure absolute HTTPS origin.",
      }),
  ),
);

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

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

function normalizePemForSignedPayload(value: string): string {
  return value.trim();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function validateCloudMintPublicKey(
  publicKey: string,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  return Effect.try({
    try: () => NodeCrypto.createPublicKey(publicKey.replace(/\\n/g, "\n")),
    catch: () =>
      new EnvironmentHttpBadRequestError({
        message: "Cloud mint public key must be a valid Ed25519 public key.",
      }),
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519"
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpBadRequestError({
              message: "Cloud mint public key must be a valid Ed25519 public key.",
            }),
          ),
    ),
  );
}

function validateRelayConfigPayload(
  payload: RelayEnvironmentConfigRequest,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  if (!isSecureRelayUrl(payload.relayUrl)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay URL must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay issuer must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.environmentCredential.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay environment credential is required.",
      }),
    );
  }
  if (payload.cloudUserId.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Cloud user id is required.",
      }),
    );
  }
  return Effect.void;
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function requestAbsoluteUrl(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return new URL(request.originalUrl).href;
  } catch {
    const host = firstForwardedHeaderValue(request.headers.host) ?? "127.0.0.1";
    try {
      return new URL(request.originalUrl, `http://${host}`).href;
    } catch {
      return null;
    }
  }
}

function hasForwardedAuthorityHeaders(request: HttpServerRequest.HttpServerRequest): boolean {
  return (
    firstForwardedHeaderValue(request.headers["x-forwarded-host"]) !== undefined ||
    firstForwardedHeaderValue(request.headers["x-forwarded-proto"]) !== undefined
  );
}

function endpointRequestPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

export function parseManagedEndpointLocalOrigin(localOrigin: string) {
  const url = new URL(localOrigin);
  if (
    localOrigin !== localOrigin.trim() ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    localOrigin.includes("?") ||
    localOrigin.includes("#")
  ) {
    throw new Error("Invalid local origin");
  }
  const wsUrl = new URL(url.origin);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    httpBaseUrl: url.origin,
    wsBaseUrl: wsUrl.origin,
    origin: {
      localHttpHost: url.hostname,
      localHttpPort: endpointRequestPort(url),
    } satisfies RelayManagedEndpointOrigin,
  };
}

function isAllowedEndpointOrigin(input: {
  readonly origin: RelayManagedEndpointOrigin;
  readonly requestUrl: string;
}): boolean {
  if (!isLoopbackHostname(input.origin.localHttpHost)) {
    return false;
  }

  const url = new URL(input.requestUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return false;
  }

  return input.origin.localHttpPort === endpointRequestPort(url);
}

// A managed (Cloudflare tunnel) endpoint is provisioned by the relay and must
// point at a loopback origin. A manual endpoint is reached out of band (e.g.
// Tailscale) or not advertised at all for publish-only links, so it is not
// tied to the managed-tunnel scope.
export function isSupportedLinkProviderKind(request: RelayLinkProofRequest): boolean {
  return (
    request.endpoint.providerKind === "cloudflare_tunnel" ||
    request.endpoint.providerKind === "manual"
  );
}

export function linkProofScopes(
  request: RelayLinkProofRequest,
): RelayEnvironmentLinkProofPayload["scopes"] {
  return request.endpoint.providerKind === "cloudflare_tunnel"
    ? ["agent_activity_notifications", "managed_tunnels"]
    : ["agent_activity_notifications"];
}

function hasExactScope(input: {
  readonly scopes: ReadonlyArray<string>;
  readonly expected: string;
}): boolean {
  return input.scopes.length === 1 && input.scopes[0] === input.expected;
}

function hasBoundedCloudProofLifetime(input: {
  readonly iat: number;
  readonly exp: number;
  readonly nowSeconds: number;
}): boolean {
  return (
    input.exp > input.iat &&
    input.exp - input.iat <= CLOUD_PROOF_MAX_LIFETIME_SECONDS &&
    input.iat <= input.nowSeconds + CLOUD_PROOF_CLOCK_SKEW_SECONDS
  );
}

function managedEndpointRuntimeConfigsMatch(
  left: RelayManagedEndpointRuntimeConfig,
  right: RelayManagedEndpointRuntimeConfig,
): boolean {
  return (
    left.providerKind === right.providerKind &&
    left.connectorToken === right.connectorToken &&
    left.tunnelId === right.tunnelId &&
    left.tunnelName === right.tunnelName
  );
}

const decodeCloudHealthProof = Schema.decodeUnknownEffect(RelayCloudEnvironmentHealthProofPayload);
const decodeCloudMintProof = Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload);

// The launcher owns this durable state, so read it directly both when a trial
// decides whether it owns pre-activation cleanup and while a server tears down.
export const pendingServiceUpdateExists = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(config.baseDir, "runtime");
  const stateText = yield* fs
    .readFileString(path.join(runtimeDir, SERVICE_STATE_FILE))
    .pipe(Effect.option);
  return Option.isSome(stateText) && serviceStateHasPendingUpdate(stateText.value);
});

// A pending update alone is not proof a replacement server is coming: an
// explicit launcher stop (`t3 service uninstall`, `systemctl stop`,
// `launchctl bootout`) during
// the pending window also tears this server down. The launcher marks that case
// just before it signals the child, so pending + no marker is the handoff.
const pendingUpdateHandoffExists = Effect.gen(function* () {
  if (!(yield* pendingServiceUpdateExists)) {
    return false;
  }
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeDir = path.join(config.baseDir, "runtime");
  const stopping = yield* fs
    .exists(path.join(runtimeDir, SERVICE_STOP_MARKER_FILE))
    .pipe(Effect.orElseSucceed(() => false));
  return !stopping;
});

// The desktop app writes its marker right before it stops this server to
// install an update, whether a remote client or the local app started it.
// Reading consumes it, so shutdown checks it first. Only a fresh marker counts,
// so a marker the server never read (a hard kill) cannot keep the tunnel on a
// later quit.
const desktopUpdateRestartPending = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.join(config.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE);
  const marker = yield* fs.stat(markerPath).pipe(Effect.option);
  if (Option.isNone(marker)) {
    return false;
  }
  yield* fs.remove(markerPath).pipe(Effect.ignore);
  const now = yield* Clock.currentTimeMillis;
  return Option.match(marker.value.mtime, {
    onNone: () => false,
    onSome: (writtenAt) =>
      now - writtenAt.getTime() < Duration.toMillis(DESKTOP_UPDATE_RESTART_MARKER_TTL),
  });
});

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

/** Failures of the link work that runs outside a request: startup, recovery and shutdown. */
type CloudLinkBackgroundError =
  | EnvironmentCloudEndpointUnavailableError
  | EnvironmentHttpBadRequestError
  | EnvironmentHttpForbiddenError
  | EnvironmentHttpInternalServerError
  | EnvironmentHttpUnauthorizedError
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
      EnvironmentHttpBadRequestError | EnvironmentHttpInternalServerError
    >;
    /** Installs the link the relay returned and, for a managed tunnel, confirms its origin. */
    readonly applyRelayConfig: (
      payload: RelayEnvironmentConfigRequest,
    ) => Effect.Effect<
      EnvironmentCloudRelayConfigResult,
      | EnvironmentCloudEndpointUnavailableError
      | EnvironmentHttpBadRequestError
      | EnvironmentHttpConflictError
      | EnvironmentHttpForbiddenError
      | EnvironmentHttpInternalServerError
      | EnvironmentHttpUnauthorizedError
    >;
    readonly linkState: () => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      EnvironmentHttpInternalServerError
    >;
    /** Stops the tunnel and forgets the link, including the CLI's wish to keep it. */
    readonly unlink: () => Effect.Effect<
      EnvironmentCloudRelayConfigResult,
      EnvironmentHttpInternalServerError
    >;
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
      EnvironmentHttpBadRequestError | EnvironmentHttpInternalServerError
    >;
    /** Answers the relay's signed health check once per proof. */
    readonly answerHealthRequest: (
      request: RelayCloudEnvironmentHealthRequest,
    ) => Effect.Effect<
      RelayEnvironmentHealthResponse,
      | EnvironmentHttpConflictError
      | EnvironmentHttpInternalServerError
      | EnvironmentHttpUnauthorizedError
    >;
    /** Issues a short-lived pairing credential for a client the relay vouched for, once per proof. */
    readonly mintCredential: (
      request: RelayCloudMintCredentialRequest,
    ) => Effect.Effect<
      RelayEnvironmentMintResponse,
      | EnvironmentHttpConflictError
      | EnvironmentHttpInternalServerError
      | EnvironmentHttpUnauthorizedError
    >;
    /** Links this environment with the stored CLI authorization and records the CLI's wish. */
    readonly reconcileDesiredLink: (
      localOrigin: string,
    ) => Effect.Effect<
      CliDesiredLinkMode,
      | CloudLinkBackgroundError
      | EnvironmentHttpConflictError
      | EnvironmentAuth.ServerAuthInternalError
      | CliTokenManager.CloudCliAuthorizationDeniedError
    >;
    /** As `reconcileDesiredLink`, but returns null when the CLI no longer wants a link. */
    readonly reconcileDesiredLinkIfStillDesired: (
      localOrigin: string,
    ) => Effect.Effect<
      CliDesiredLinkMode | null,
      | CloudLinkBackgroundError
      | EnvironmentHttpConflictError
      | EnvironmentAuth.ServerAuthInternalError
      | CliTokenManager.CloudCliAuthorizationDeniedError
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
      | EnvironmentCloudEndpointUnavailableError
      | EnvironmentHttpBadRequestError
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
  ): Effect.Effect<void, EnvironmentAuth.ServerAuthInternalError | EnvironmentHttpConflictError> =>
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
          : Effect.fail(
              new EnvironmentHttpConflictError({
                message:
                  "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
              }),
            );
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
      return yield* new EnvironmentHttpBadRequestError({
        message: "Invalid managed endpoint origin.",
      });
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
        return yield* new EnvironmentHttpBadRequestError({
          message: "Invalid managed endpoint origin.",
        });
      }
      const proof = yield* makeCloudLinkProof(request, requestUrl);
      return proof satisfies RelayEnvironmentLinkProof;
    },
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentCloudInternalError(error.message)(error),
    ),
    Effect.catchIf(
      ServerSecretStore.isSecretStoreError,
      failEnvironmentCloudInternalError("Could not generate environment link proof."),
    ),
    Effect.catchTag(
      "PlatformError",
      failEnvironmentCloudInternalError("Could not generate environment link proof."),
    ),
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
            return yield* new EnvironmentCloudEndpointUnavailableError({
              message: "Managed endpoint runtime could not be started.",
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
              error._tag === "EnvironmentCloudEndpointUnavailableError" &&
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
      catch: () =>
        new EnvironmentHttpBadRequestError({
          message: "Could not resolve local environment origin.",
        }),
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
          return yield* new EnvironmentCloudEndpointUnavailableError({
            message: "Managed endpoint runtime could not be started.",
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
        return yield* new EnvironmentCloudEndpointUnavailableError({
          message: "Managed endpoint runtime could not be started.",
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
        return yield* new EnvironmentCloudEndpointUnavailableError({
          message: "Managed endpoint runtime could not be started.",
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
        catch: () =>
          new EnvironmentHttpBadRequestError({
            message: "Could not resolve local environment origin.",
          }),
      });
      const token = yield* cliTokenManager.getExisting.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new EnvironmentHttpUnauthorizedError({
                  message: "Run `t3 connect link` to authorize this environment.",
                }),
              ),
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
    Effect.catchIf(
      ServerSecretStore.isSecretStoreError,
      failEnvironmentCloudInternalError("Could not persist desired T3 Connect link state."),
    ),
    Effect.catchTags({
      CloudCliCredentialRemovalError: failCloudCliTokenManagerError,
      CloudCliCredentialRefreshError: failCloudCliTokenManagerError,
      CloudCliCredentialReadError: failCloudCliTokenManagerError,
      CloudCliAuthorizationError: failCloudCliTokenManagerError,
      CloudCliAuthorizationTimeoutError: failCloudCliTokenManagerError,
    }),
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
        () =>
          new EnvironmentHttpInternalServerError({
            message: "Could not sign the managed tunnel recovery request.",
          }),
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
      catch: () =>
        new EnvironmentHttpBadRequestError({
          message: "Could not resolve local environment origin.",
        }),
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
      catch: () =>
        new EnvironmentHttpBadRequestError({
          message: "Could not resolve local environment origin.",
        }),
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
      return yield* new EnvironmentHttpInternalServerError({
        message: "T3 Connect returned an unsupported managed tunnel configuration.",
      });
    }

    const encoded = yield* encodeEndpointRuntimeConfigJson(recovered.endpointRuntime).pipe(
      Effect.mapError(
        () =>
          new EnvironmentHttpInternalServerError({
            message: "Could not persist the recovered managed tunnel configuration.",
          }),
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
          return yield* new EnvironmentHttpInternalServerError({
            message: "Could not resolve the local server origin.",
          });
        }
        const registration = yield* registerManagedTunnelRecovery(
          `http://127.0.0.1:${address.port}`,
        ).pipe(
          Effect.retry({
            times: 2,
            while: (error) =>
              shouldRetryCloudLink(error) &&
              error._tag !== "EnvironmentCloudEndpointUnavailableError",
          }),
        );
        if (registration.status === "superseded") {
          return yield* new EnvironmentHttpConflictError({
            message: "The managed tunnel configuration changed during registration.",
          });
        }
        if (registration.status === "recovery_required") {
          yield* endpointRuntime.requestRecovery(registration.config);
        }
        if (registration.status !== "ready") {
          return yield* new EnvironmentCloudEndpointUnavailableError({
            message: "Managed endpoint origin could not be confirmed.",
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
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentCloudInternalError(error.message)(error),
    ),
    Effect.catchIf(
      ServerSecretStore.isSecretStoreError,
      failEnvironmentCloudInternalError("Could not persist environment relay configuration."),
    ),
    Effect.catchTags({
      SchemaError: failEnvironmentCloudInternalError(
        "Could not persist environment relay configuration.",
      ),
      PlatformError: failEnvironmentCloudInternalError(
        "Could not register the managed endpoint origin.",
      ),
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
    Effect.catchIf(
      ServerSecretStore.isSecretStoreError,
      failEnvironmentCloudInternalError("Could not read environment relay configuration."),
    ),
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
    Effect.catchIf(
      ServerSecretStore.isSecretStoreError,
      failEnvironmentCloudInternalError("Could not remove environment relay configuration."),
    ),
  );

  const pushHoldWebhooksWhileOffline = Effect.fn("CloudPreferences.pushHoldWebhooksWhileOffline")(
    function* (holdWebhooksWhileOffline: boolean) {
      const connection = yield* readRelayConnection.pipe(withSecrets);
      if (connection === null) {
        return yield* new EnvironmentHttpBadRequestError({
          message: "Link this environment to T3 Connect first.",
        });
      }
      const environmentId = yield* environment.getEnvironmentId;
      const client = yield* makeRelayEnvironmentClient(connection);
      yield* client.server
        .updateLinkPreferences({
          params: { environmentId },
          payload: { holdWebhooksWhileOffline },
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(
            failEnvironmentCloudInternalError("Could not update T3 Connect webhook settings."),
          ),
        );
    },
  );

  const savePreference = (name: string, value: boolean) =>
    secrets
      .set(name, stringToBytes(String(value)))
      .pipe(
        Effect.catch(
          failEnvironmentCloudInternalError("Could not persist environment cloud preferences."),
        ),
      );

  // One update at a time, so two requests can't each leave one setting behind.
  const preferencesLock = yield* Semaphore.make(1);

  const savePreferences = Effect.fn("CloudPreferences.update")(
    function* (input: EnvironmentCloudPreferencesRequest) {
      // All or nothing: the activity setting is saved first, before the relay
      // is told anything, and put back if the hold change then fails. Both
      // current values are read up front; a failed read stops here, before
      // anything changes, because a guessed value would be the rollback target.
      const readCurrent = (name: string) =>
        secrets
          .get(name)
          .pipe(
            Effect.catch(
              failEnvironmentCloudInternalError("Could not read environment cloud preferences."),
            ),
          );
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
    Effect.catchIf(
      ServerSecretStore.isSecretStoreError,
      failEnvironmentCloudInternalError("Could not read environment cloud preferences."),
    ),
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
        return yield* new EnvironmentHttpUnauthorizedError({
          message: "Invalid cloud health request.",
        });
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
        return yield* new EnvironmentHttpConflictError({
          message: "Cloud health request was already consumed.",
        });
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
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentCloudInternalError(error.message)(error),
    ),
    Effect.catchIf(
      ServerSecretStore.isSecretStoreError,
      failEnvironmentCloudInternalError("Could not answer cloud health request."),
    ),
    Effect.catchTag(
      "PlatformError",
      failEnvironmentCloudInternalError("Could not answer cloud health request."),
    ),
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
        return yield* new EnvironmentHttpUnauthorizedError({
          message: "Invalid cloud mint request.",
        });
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
        return yield* new EnvironmentHttpConflictError({
          message: "Cloud mint request was already consumed.",
        });
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
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentCloudInternalError(error.message)(error),
    ),
    Effect.catchIf(
      ServerSecretStore.isSecretStoreError,
      failEnvironmentCloudInternalError("Could not issue cloud connection credential."),
    ),
    Effect.catchTag(
      "PlatformError",
      failEnvironmentCloudInternalError("Could not issue cloud connection credential."),
    ),
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
