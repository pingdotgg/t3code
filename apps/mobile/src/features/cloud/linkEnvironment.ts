import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import {
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import { stripPairingTokenFromUrl } from "@t3tools/shared/remote";
import {
  type RelayEnvironmentConnectResponse as RelayEnvironmentConnectResponseType,
  type RelayEnvironmentLinkResponse as RelayEnvironmentLinkResponseType,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayProtectedError,
  type RelayDpopAccessTokenScope,
  type RelayProtectedError as RelayProtectedErrorType,
  type RelayClientEnvironmentRecord,
  type RelayEnvironmentStatusResponse as RelayEnvironmentStatusResponseType,
  type RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import {
  exchangeRemoteDpopAccessToken,
  fetchRemoteEnvironmentDescriptor,
  makeEnvironmentHttpApiClient,
  ManagedRelayClient,
  ManagedRelayDpopSigner,
} from "@t3tools/client-runtime";

import { mobileAuthClientMetadata } from "../../lib/authClientMetadata";
import type { SavedRemoteConnection } from "../../lib/connection";
import { loadOrCreateAgentAwarenessDeviceId, loadPreferences } from "../../lib/storage";
import { resolveCloudPublicConfig } from "./publicConfig";

const RELAY_STATUS_AND_CONNECT_SCOPES = [
  RelayEnvironmentStatusScope,
  RelayEnvironmentConnectScope,
] satisfies ReadonlyArray<RelayDpopAccessTokenScope>;

export function normalizeRelayBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function readRelayUrl(): string | null {
  return resolveCloudPublicConfig().relayUrl;
}

export class CloudEnvironmentLinkError extends Data.TaggedError("CloudEnvironmentLinkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CloudEnvironmentRecordWithStatus {
  readonly environment: RelayClientEnvironmentRecord;
  readonly status: RelayEnvironmentStatusResponseType | null;
  readonly statusError: string | null;
}

const isRelayProtectedError = Schema.is(RelayProtectedError);
const isEnvironmentCloudApiError = Schema.is(
  Schema.Union([
    EnvironmentHttpBadRequestError,
    EnvironmentHttpUnauthorizedError,
    EnvironmentHttpForbiddenError,
    EnvironmentHttpConflictError,
    EnvironmentHttpInternalServerError,
    EnvironmentCloudEndpointUnavailableError,
  ]),
);

const MANAGED_ENDPOINT_PROVIDER_KIND =
  "cloudflare_tunnel" satisfies RelayManagedEndpointProviderKind;

function cloudEnvironmentLinkError(message: string) {
  return (cause: unknown) => {
    const environmentError = findEnvironmentCloudApiError(cause);
    return new CloudEnvironmentLinkError({
      message: environmentError
        ? `${message.replace(/[.:]$/, "")}: ${environmentError.message}`
        : withDevCause(message, cause),
      cause,
    });
  };
}

function isDevRuntime(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__;
}

function causeMessage(cause: unknown): string | null {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  if (typeof cause === "object" && cause !== null) {
    const record = cause as { readonly message?: unknown; readonly cause?: unknown };
    if (typeof record.message === "string" && record.message.length > 0) {
      const nested = causeMessage(record.cause);
      return nested ? `${record.message}: ${nested}` : record.message;
    }
  }
  return null;
}

function withDevCause(message: string, cause: unknown): string {
  if (!isDevRuntime()) {
    return message;
  }
  const detail = causeMessage(cause);
  return detail ? `${message} (${detail})` : message;
}

function relayProtectedErrorMessage(error: RelayProtectedErrorType): string {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return "Relay rejected the cloud session token.";
        case "invalid_dpop":
          return "Relay rejected the DPoP proof.";
        case "not_authorized":
          return "Relay rejected the authenticated request.";
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return "Relay rejected an expired environment link proof.";
    case "RelayEnvironmentLinkProofInvalidError":
      return `Relay rejected the environment link proof (${error.reason}).`;
    case "RelayEnvironmentConnectNotAuthorizedError":
      return "Relay rejected the environment connection request.";
    case "RelayEnvironmentEndpointUnavailableError":
      return `Relay could not reach the environment endpoint (${error.reason}).`;
    case "RelayEnvironmentEndpointTimedOutError":
      return "Relay timed out while contacting the environment endpoint.";
    case "RelayEnvironmentLinkFailedError":
      return `Relay could not link the environment (${error.reason}).`;
    case "RelayEnvironmentLinkUnavailableError":
      return `Relay cannot provision the managed endpoint (${error.reason}).`;
    case "RelayAgentActivityPublishProofExpiredError":
      return "Relay rejected an expired agent activity publish proof.";
    case "RelayAgentActivityPublishProofInvalidError":
      return `Relay rejected the agent activity publish proof (${error.reason}).`;
    case "RelayInternalError":
      return `Relay encountered an internal error (${error.reason}, trace ${error.traceId}).`;
  }
}

function decodedRelayClientError(message: string) {
  return (cause: unknown) => {
    const relayError = findRelayProtectedError(cause);
    const detail = relayError ? relayProtectedErrorMessage(relayError) : null;
    return new CloudEnvironmentLinkError({
      message: detail ? `${message}: ${detail}` : message,
      cause,
    });
  };
}

function findRelayProtectedError(cause: unknown): RelayProtectedErrorType | null {
  if (isRelayProtectedError(cause)) {
    return cause;
  }
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  return "cause" in cause ? findRelayProtectedError(cause.cause) : null;
}

function findEnvironmentCloudApiError(cause: unknown): { readonly message: string } | null {
  if (isEnvironmentCloudApiError(cause)) {
    return cause;
  }
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  return "cause" in cause ? findEnvironmentCloudApiError(cause.cause) : null;
}

function requireRelayUrl(): Effect.Effect<string, CloudEnvironmentLinkError> {
  const relayUrl = readRelayUrl();
  return relayUrl
    ? Effect.succeed(relayUrl)
    : Effect.fail(new CloudEnvironmentLinkError({ message: "Relay URL is not configured." }));
}

function endpointOrigin(httpBaseUrl: string) {
  const url = new URL(httpBaseUrl);
  return {
    localHttpHost: "127.0.0.1",
    localHttpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

function ensureLinkedEnvironmentMatches(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponseType;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (input.link.environmentId !== input.expectedEnvironmentId) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned credentials for a different environment.",
    });
  }
  if (input.link.endpoint.providerKind !== input.expectedProviderKind) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned credentials for a different endpoint provider.",
    });
  }
  return Effect.void;
}

function endpointMatches(
  left: RelayClientEnvironmentRecord["endpoint"],
  right: RelayClientEnvironmentRecord["endpoint"],
): boolean {
  return (
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl &&
    left.providerKind === right.providerKind
  );
}

function ensureStatusMatchesEnvironment(input: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly status: RelayEnvironmentStatusResponseType;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (input.status.environmentId !== input.environment.environmentId) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned status for a different environment.",
    });
  }
  if (!endpointMatches(input.status.endpoint, input.environment.endpoint)) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned status for a different endpoint.",
    });
  }
  if (
    input.status.descriptor &&
    input.status.descriptor.environmentId !== input.environment.environmentId
  ) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned status descriptor for a different environment.",
    });
  }
  return Effect.void;
}

function ensureConnectEndpointMatchesEnvironment(input: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly connect: RelayEnvironmentConnectResponseType;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (!endpointMatches(input.connect.endpoint, input.environment.endpoint)) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned credentials for a different endpoint.",
    });
  }
  return Effect.void;
}

export function linkEnvironmentToCloud(input: {
  readonly connection: SavedRemoteConnection;
  readonly clerkToken: string;
}): Effect.Effect<void, CloudEnvironmentLinkError, HttpClient.HttpClient | ManagedRelayClient> {
  return Effect.gen(function* () {
    if (!input.connection.bearerToken) {
      return yield* new CloudEnvironmentLinkError({
        message: "Only a locally paired bearer connection can be linked to the cloud.",
      });
    }
    const localBearerToken = input.connection.bearerToken;
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelayClient;
    const deviceId = yield* Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: cloudEnvironmentLinkError("Could not load the mobile device id."),
    });
    const preferences = yield* Effect.tryPromise({
      try: () => loadPreferences(),
      catch: cloudEnvironmentLinkError("Could not load mobile notification preferences."),
    });
    const liveActivitiesEnabled = preferences.liveActivitiesEnabled !== false;
    const challenge = yield* relayClient
      .createEnvironmentLinkChallenge({
        clerkToken: input.clerkToken,
        payload: {
          notificationsEnabled: true,
          liveActivitiesEnabled,
          managedTunnelsEnabled: true,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(`${relayUrl}/v1/client/environment-link-challenges failed`),
        ),
      );
    const environmentClient = yield* makeEnvironmentHttpApiClient(input.connection.httpBaseUrl);
    const proof = yield* environmentClient.cloud
      .linkProof({
        headers: { authorization: `Bearer ${localBearerToken}` },
        payload: {
          challenge: challenge.challenge,
          relayIssuer: relayUrl,
          endpoint: {
            httpBaseUrl: input.connection.httpBaseUrl,
            wsBaseUrl: input.connection.wsBaseUrl,
            providerKind: MANAGED_ENDPOINT_PROVIDER_KIND,
          },
          origin: endpointOrigin(input.connection.httpBaseUrl),
        },
      })
      .pipe(Effect.mapError(cloudEnvironmentLinkError("Could not obtain environment link proof.")));
    const link = yield* relayClient
      .linkEnvironment({
        clerkToken: input.clerkToken,
        payload: {
          deviceId,
          proof,
          notificationsEnabled: true,
          liveActivitiesEnabled,
          managedTunnelsEnabled: true,
        },
      })
      .pipe(
        Effect.mapError(decodedRelayClientError(`${relayUrl}/v1/client/environment-links failed`)),
      );
    yield* ensureLinkedEnvironmentMatches({
      expectedEnvironmentId: input.connection.environmentId,
      expectedProviderKind: MANAGED_ENDPOINT_PROVIDER_KIND,
      link,
    });

    yield* environmentClient.cloud
      .relayConfig({
        headers: { authorization: `Bearer ${localBearerToken}` },
        payload: {
          relayUrl,
          relayIssuer: link.relayIssuer,
          cloudUserId: link.cloudUserId,
          environmentCredential: link.environmentCredential,
          cloudMintPublicKey: link.cloudMintPublicKey,
          endpointRuntime: link.endpointRuntime,
        },
      })
      .pipe(
        Effect.mapError(cloudEnvironmentLinkError("Could not configure environment relay access.")),
      );
  });
}

export function listCloudEnvironments(input: {
  readonly clerkToken: string;
}): Effect.Effect<
  ReadonlyArray<RelayClientEnvironmentRecord>,
  CloudEnvironmentLinkError,
  ManagedRelayClient
> {
  return Effect.gen(function* () {
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelayClient;

    return yield* relayClient
      .listEnvironments({
        clerkToken: input.clerkToken,
      })
      .pipe(Effect.mapError(decodedRelayClientError(`${relayUrl}/v1/environments failed`)));
  });
}

export function getCloudEnvironmentStatus(input: {
  readonly clerkToken: string;
  readonly environment: RelayClientEnvironmentRecord;
  readonly relayScopes?: ReadonlyArray<RelayDpopAccessTokenScope>;
}): Effect.Effect<
  RelayEnvironmentStatusResponseType,
  CloudEnvironmentLinkError,
  ManagedRelayClient
> {
  return Effect.gen(function* () {
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelayClient;
    const status = yield* relayClient
      .getEnvironmentStatus({
        clerkToken: input.clerkToken,
        scopes: input.relayScopes ?? [RelayEnvironmentStatusScope],
        environmentId: input.environment.environmentId,
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(
            `${relayUrl}/v1/environments/${encodeURIComponent(input.environment.environmentId)}/status failed`,
          ),
        ),
      );
    yield* ensureStatusMatchesEnvironment({ environment: input.environment, status });
    return status;
  });
}

export function cloudEnvironmentsPendingStatus(
  environments: ReadonlyArray<RelayClientEnvironmentRecord>,
): ReadonlyArray<CloudEnvironmentRecordWithStatus> {
  return environments.map((environment) => ({
    environment,
    status: null,
    statusError: "Checking status...",
  }));
}

export function loadCloudEnvironmentStatuses(input: {
  readonly clerkToken: string;
  readonly environments: ReadonlyArray<RelayClientEnvironmentRecord>;
}): Effect.Effect<
  ReadonlyArray<CloudEnvironmentRecordWithStatus>,
  CloudEnvironmentLinkError,
  ManagedRelayClient
> {
  return Effect.forEach(
    input.environments,
    (environment) =>
      getCloudEnvironmentStatus({
        clerkToken: input.clerkToken,
        environment,
        relayScopes: RELAY_STATUS_AND_CONNECT_SCOPES,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({
            environment,
            status: null,
            statusError: error.message,
          }),
          onSuccess: (status) => ({
            environment,
            status,
            statusError: null,
          }),
        }),
      ),
    { concurrency: "unbounded" },
  );
}

export function listCloudEnvironmentsWithStatus(input: {
  readonly clerkToken: string;
}): Effect.Effect<
  ReadonlyArray<CloudEnvironmentRecordWithStatus>,
  CloudEnvironmentLinkError,
  ManagedRelayClient
> {
  return Effect.gen(function* () {
    const environments = yield* listCloudEnvironments(input);
    return yield* loadCloudEnvironmentStatuses({
      clerkToken: input.clerkToken,
      environments,
    });
  });
}

function connectRelayManagedEnvironment(input: {
  readonly clerkToken: string;
  readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
  readonly expectedEnvironment?: RelayClientEnvironmentRecord;
}): Effect.Effect<
  SavedRemoteConnection,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelayClient | ManagedRelayDpopSigner
> {
  return Effect.gen(function* () {
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelayClient;

    const deviceId = yield* Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: cloudEnvironmentLinkError("Could not load the mobile device id."),
    });
    const connect = yield* relayClient
      .connectEnvironment({
        clerkToken: input.clerkToken,
        scopes: [RelayEnvironmentConnectScope],
        environmentId: input.environmentId,
        deviceId,
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(
            `${relayUrl}/v1/environments/${encodeURIComponent(input.environmentId)}/connect failed`,
          ),
        ),
      );
    if (connect.environmentId !== input.environmentId) {
      return yield* new CloudEnvironmentLinkError({
        message: "Relay returned credentials for a different environment.",
      });
    }
    if (input.expectedEnvironment) {
      yield* ensureConnectEndpointMatchesEnvironment({
        environment: input.expectedEnvironment,
        connect,
      });
    }

    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: connect.endpoint.httpBaseUrl,
    }).pipe(
      Effect.mapError(
        cloudEnvironmentLinkError("Could not fetch the connected environment descriptor."),
      ),
    );
    if (descriptor.environmentId !== connect.environmentId) {
      return yield* new CloudEnvironmentLinkError({
        message: "Connected endpoint descriptor does not match the selected environment.",
      });
    }
    const signer = yield* ManagedRelayDpopSigner;
    const bootstrapDpop = yield* signer
      .createProof({
        method: "POST",
        url: new URL("/oauth/token", connect.endpoint.httpBaseUrl).toString(),
      })
      .pipe(Effect.mapError(cloudEnvironmentLinkError("Could not create bootstrap DPoP proof.")));
    const bootstrap = yield* exchangeRemoteDpopAccessToken({
      httpBaseUrl: connect.endpoint.httpBaseUrl,
      credential: connect.credential,
      dpopProof: bootstrapDpop,
      clientMetadata: mobileAuthClientMetadata(),
    }).pipe(
      Effect.mapError(
        cloudEnvironmentLinkError("Could not exchange a managed endpoint DPoP access token."),
      ),
    );
    const pairingUrl = new URL(connect.endpoint.httpBaseUrl);
    pairingUrl.hash = new URLSearchParams([["token", connect.credential]]).toString();

    return {
      environmentId: descriptor.environmentId,
      environmentLabel: descriptor.label,
      pairingUrl: stripPairingTokenFromUrl(pairingUrl).toString(),
      displayUrl: connect.endpoint.httpBaseUrl,
      httpBaseUrl: connect.endpoint.httpBaseUrl,
      wsBaseUrl: connect.endpoint.wsBaseUrl,
      bearerToken: null,
      authenticationMethod: "dpop",
      dpopAccessToken: bootstrap.access_token,
      relayManaged: true,
    };
  });
}

export function connectCloudEnvironment(input: {
  readonly clerkToken: string;
  readonly environment: RelayClientEnvironmentRecord;
}): Effect.Effect<
  SavedRemoteConnection,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelayClient | ManagedRelayDpopSigner
> {
  return connectRelayManagedEnvironment({
    clerkToken: input.clerkToken,
    environmentId: input.environment.environmentId,
    expectedEnvironment: input.environment,
  });
}

export function refreshCloudEnvironmentConnection(input: {
  readonly clerkToken: string;
  readonly connection: SavedRemoteConnection;
}): Effect.Effect<
  SavedRemoteConnection,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelayClient | ManagedRelayDpopSigner
> {
  return connectRelayManagedEnvironment({
    clerkToken: input.clerkToken,
    environmentId: input.connection.environmentId,
  });
}
