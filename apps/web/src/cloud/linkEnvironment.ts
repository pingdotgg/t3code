import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import {
  EnvironmentCloudEndpointUnavailableError,
  type EnvironmentCloudLinkStateResult,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  type RelayClientDeviceRecord,
  type RelayEnvironmentLinkResponse,
  RelayProtectedError,
  type RelayClientEnvironmentRecord,
  type RelayProtectedError as RelayProtectedErrorType,
  type RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import {
  exchangeRemoteDpopAccessToken,
  fetchRemoteEnvironmentDescriptor,
  makeEnvironmentHttpApiClient,
  ManagedRelayClient,
  ManagedRelayDpopSigner,
  type WsRpcClient,
} from "@t3tools/client-runtime";

import { ensureLocalApi } from "../localApi";
import {
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
  type SavedEnvironmentRecord,
} from "../environments/runtime";
import {
  readPrimaryEnvironmentDescriptor,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "../environments/primary";
import { withPrimaryEnvironmentRequestInit } from "../environments/primary/requestInit";
import { resolveCloudPublicConfig } from "./publicConfig";
import {
  finishRelayClientInstall,
  reportRelayClientInstallProgress,
  requestRelayClientInstallConfirmation,
} from "./relayClientInstallDialog";

export function normalizeRelayBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function relayUrl(): string | null {
  return resolveCloudPublicConfig().relayUrl;
}

export class CloudEnvironmentLinkError extends Data.TaggedError("CloudEnvironmentLinkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const relayClientRpcError = (message: string) => (cause: unknown) =>
  new CloudEnvironmentLinkError({
    message,
    cause,
  });

function ensureRelayClientAvailable(
  client: WsRpcClient,
): Effect.Effect<void, CloudEnvironmentLinkError> {
  return Effect.gen(function* () {
    const status = yield* Effect.tryPromise({
      try: () => client.cloud.getRelayClientStatus(),
      catch: relayClientRpcError("Could not check relay client availability."),
    });
    if (status.status === "available") return;
    if (status.status === "unsupported") {
      return yield* new CloudEnvironmentLinkError({
        message: `T3 Code cannot install the relay client automatically on ${status.platform}-${status.arch}.`,
      });
    }

    const confirmed = yield* Effect.tryPromise({
      try: () => requestRelayClientInstallConfirmation(status.version),
      catch: relayClientRpcError("Could not confirm relay client installation."),
    });
    if (!confirmed) {
      return yield* new CloudEnvironmentLinkError({
        message: "Relay client installation was cancelled.",
      });
    }

    const installed = yield* Effect.tryPromise({
      try: () => client.cloud.installRelayClient(reportRelayClientInstallProgress),
      catch: relayClientRpcError("Could not install the relay client."),
    }).pipe(Effect.ensuring(Effect.sync(finishRelayClientInstall)));
    if (installed.status !== "available") {
      return yield* new CloudEnvironmentLinkError({
        message:
          installed.status === "unsupported"
            ? `T3 Code cannot install the relay client automatically on ${installed.platform}-${installed.arch}.`
            : "The relay client is still unavailable after installation.",
      });
    }
  });
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

const environmentApiError = (message: string) => (cause: unknown) => {
  const environmentError = findEnvironmentCloudApiError(cause);
  return new CloudEnvironmentLinkError({
    message: environmentError
      ? `${message.replace(/[.:]$/, "")}: ${environmentError.message}`
      : message,
    cause,
  });
};

function endpointOrigin(httpBaseUrl: string) {
  const url = new URL(httpBaseUrl);
  return {
    localHttpHost: "127.0.0.1",
    localHttpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

const MANAGED_ENDPOINT_PROVIDER_KIND =
  "cloudflare_tunnel" satisfies RelayManagedEndpointProviderKind;

function ensureLinkedEnvironmentMatches(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponse;
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

export interface CloudLinkTarget {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export type CloudLinkState = EnvironmentCloudLinkStateResult;

export interface CloudManagedConnection {
  readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly relayUrl: string;
  readonly accessToken: string;
}

export function collectCloudLinkTargets(input: {
  readonly primary: CloudLinkTarget | null;
  readonly saved: ReadonlyArray<CloudLinkTarget>;
}): ReadonlyArray<CloudLinkTarget> {
  const byId = new Map<string, CloudLinkTarget>();
  if (input.primary) {
    byId.set(input.primary.environmentId, input.primary);
  }
  for (const environment of input.saved) {
    if (!byId.has(environment.environmentId)) {
      byId.set(environment.environmentId, environment);
    }
  }
  return [...byId.values()];
}

export function readPrimaryCloudLinkTarget(): CloudLinkTarget | null {
  const descriptor = readPrimaryEnvironmentDescriptor();
  const target = readPrimaryEnvironmentTarget();
  if (!descriptor || !target) {
    return null;
  }
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    httpBaseUrl: target.target.httpBaseUrl,
    wsBaseUrl: target.target.wsBaseUrl,
  };
}

export function listManagedCloudEnvironments(input: {
  readonly clerkToken: string;
}): Effect.Effect<
  ReadonlyArray<RelayClientEnvironmentRecord>,
  CloudEnvironmentLinkError,
  ManagedRelayClient
> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "T3CODE_RELAY_URL is not configured.",
      });
    }
    const relayClient = yield* ManagedRelayClient;
    return yield* relayClient
      .listEnvironments({
        clerkToken: input.clerkToken,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CloudEnvironmentLinkError({
              message: "Could not list relay-managed environments.",
              cause,
            }),
        ),
      );
  });
}

export function listCloudDevices(input: {
  readonly clerkToken: string;
}): Effect.Effect<
  ReadonlyArray<RelayClientDeviceRecord>,
  CloudEnvironmentLinkError,
  ManagedRelayClient
> {
  return Effect.gen(function* () {
    if (!relayUrl()) {
      return yield* new CloudEnvironmentLinkError({
        message: "T3CODE_RELAY_URL is not configured.",
      });
    }
    const relayClient = yield* ManagedRelayClient;
    return yield* relayClient.listDevices({ clerkToken: input.clerkToken }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: "Could not list cloud devices.",
            cause,
          }),
      ),
    );
  });
}

export function connectManagedCloudEnvironment(input: {
  readonly clerkToken: string;
  readonly environment: RelayClientEnvironmentRecord;
  readonly relayUrl?: string;
}): Effect.Effect<
  CloudManagedConnection,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelayClient | ManagedRelayDpopSigner
> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "T3CODE_RELAY_URL is not configured.",
      });
    }
    const persistedRelayUrl = normalizeRelayBaseUrl(input.relayUrl);
    if (persistedRelayUrl && persistedRelayUrl !== configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "The saved environment is linked through a different configured relay.",
      });
    }
    const relayClient = yield* ManagedRelayClient;
    const connected = yield* relayClient
      .connectEnvironment({
        clerkToken: input.clerkToken,
        scopes: [RelayEnvironmentConnectScope],
        environmentId: input.environment.environmentId,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CloudEnvironmentLinkError({
              message: "Could not connect to relay-managed environment.",
              cause,
            }),
        ),
      );
    if (connected.environmentId !== input.environment.environmentId) {
      return yield* new CloudEnvironmentLinkError({
        message: "Relay returned credentials for a different environment.",
      });
    }
    if (
      connected.endpoint.httpBaseUrl !== input.environment.endpoint.httpBaseUrl ||
      connected.endpoint.wsBaseUrl !== input.environment.endpoint.wsBaseUrl ||
      connected.endpoint.providerKind !== input.environment.endpoint.providerKind
    ) {
      return yield* new CloudEnvironmentLinkError({
        message: "Relay returned credentials for a different endpoint.",
      });
    }
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: connected.endpoint.httpBaseUrl,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: "Could not read connected environment descriptor.",
            cause,
          }),
      ),
    );
    if (descriptor.environmentId !== connected.environmentId) {
      return yield* new CloudEnvironmentLinkError({
        message: "Connected endpoint does not match the selected environment.",
      });
    }
    const signer = yield* ManagedRelayDpopSigner;
    const bootstrapProof = yield* signer
      .createProof({
        method: "POST",
        url: new URL("/oauth/token", connected.endpoint.httpBaseUrl).toString(),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CloudEnvironmentLinkError({
              message: "Could not create environment DPoP proof.",
              cause,
            }),
        ),
      );
    const session = yield* exchangeRemoteDpopAccessToken({
      httpBaseUrl: connected.endpoint.httpBaseUrl,
      credential: connected.credential,
      dpopProof: bootstrapProof,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: "Could not authorize managed environment.",
            cause,
          }),
      ),
    );
    return {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: connected.endpoint.httpBaseUrl,
      wsBaseUrl: connected.endpoint.wsBaseUrl,
      relayUrl: configuredRelayUrl,
      accessToken: session.access_token,
    };
  });
}

export function readPrimaryCloudLinkState(): Effect.Effect<
  CloudLinkState | null,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    if (!readPrimaryCloudLinkTarget()) {
      return null;
    }
    const client = yield* makeEnvironmentHttpApiClient(resolvePrimaryEnvironmentHttpUrl("/"));
    return yield* client.connect
      .linkState({ headers: {} })
      .pipe(
        withPrimaryEnvironmentRequestInit,
        Effect.mapError(environmentApiError("Could not read environment cloud link state.")),
      );
  });
}

export function updatePrimaryCloudPreferences(input: {
  readonly publishAgentActivity: boolean;
}): Effect.Effect<CloudLinkState, CloudEnvironmentLinkError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(resolvePrimaryEnvironmentHttpUrl("/"));
    return yield* client.connect
      .preferences({
        headers: {},
        payload: input,
      })
      .pipe(
        withPrimaryEnvironmentRequestInit,
        Effect.mapError(environmentApiError("Could not update environment cloud preferences.")),
      );
  });
}

export function unlinkPrimaryEnvironmentFromCloud(input: {
  readonly clerkToken: string | null;
}): Effect.Effect<void, CloudEnvironmentLinkError, HttpClient.HttpClient | ManagedRelayClient> {
  return Effect.gen(function* () {
    const target = readPrimaryCloudLinkTarget();
    if (!target) {
      return yield* new CloudEnvironmentLinkError({
        message: "Local environment is not ready yet.",
      });
    }
    const client = yield* makeEnvironmentHttpApiClient(resolvePrimaryEnvironmentHttpUrl("/"));
    yield* client.connect
      .unlink({ headers: {} })
      .pipe(
        withPrimaryEnvironmentRequestInit,
        Effect.mapError(environmentApiError("Could not unlink the environment from cloud.")),
      );

    const configuredRelayUrl = relayUrl();
    if (configuredRelayUrl && input.clerkToken) {
      const relayClient = yield* ManagedRelayClient;
      yield* relayClient
        .unlinkEnvironment({
          clerkToken: input.clerkToken,
          environmentId: EnvironmentId.make(target.environmentId),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not revoke cloud environment link after local unlink.", {
              cause,
            }),
          ),
        );
    }
  });
}

export function linkEnvironmentToCloud(input: {
  readonly environment: SavedEnvironmentRecord;
  readonly clerkToken: string;
}): Effect.Effect<void, CloudEnvironmentLinkError, HttpClient.HttpClient | ManagedRelayClient> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "T3CODE_RELAY_URL is not configured.",
      });
    }
    const relayClient = yield* ManagedRelayClient;
    const bearerToken = yield* Effect.tryPromise({
      try: () =>
        ensureLocalApi().persistence.getSavedEnvironmentSecret(input.environment.environmentId),
      catch: (cause) =>
        new CloudEnvironmentLinkError({
          message: `Could not read saved bearer token for ${input.environment.label}.`,
          cause,
        }),
    });
    if (!bearerToken) {
      return yield* new CloudEnvironmentLinkError({
        message: `No saved bearer token for ${input.environment.label}.`,
      });
    }

    const connection = readEnvironmentConnection(input.environment.environmentId);
    if (!connection) {
      return yield* new CloudEnvironmentLinkError({
        message: `${input.environment.label} is not connected.`,
      });
    }
    yield* ensureRelayClientAvailable(connection.client);

    const environmentClient = yield* makeEnvironmentHttpApiClient(input.environment.httpBaseUrl);
    const headers = { authorization: `Bearer ${bearerToken}` };

    const challenge = yield* relayClient
      .createEnvironmentLinkChallenge({
        clerkToken: input.clerkToken,
        payload: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(
            `${configuredRelayUrl}/v1/client/environment-link-challenges failed`,
          ),
        ),
      );
    const proof = yield* environmentClient.connect
      .linkProof({
        headers,
        payload: {
          challenge: challenge.challenge,
          relayIssuer: configuredRelayUrl,
          endpoint: {
            httpBaseUrl: input.environment.httpBaseUrl,
            wsBaseUrl: input.environment.wsBaseUrl,
            providerKind: MANAGED_ENDPOINT_PROVIDER_KIND,
          },
          origin: endpointOrigin(input.environment.httpBaseUrl),
        },
      })
      .pipe(Effect.mapError(environmentApiError("Could not obtain environment link proof.")));
    const link = yield* relayClient
      .linkEnvironment({
        clerkToken: input.clerkToken,
        payload: {
          proof,
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(`${configuredRelayUrl}/v1/client/environment-links failed`),
        ),
      );
    yield* ensureLinkedEnvironmentMatches({
      expectedEnvironmentId: input.environment.environmentId,
      expectedProviderKind: MANAGED_ENDPOINT_PROVIDER_KIND,
      link,
    });

    yield* environmentClient.connect
      .relayConfig({
        headers,
        payload: {
          relayUrl: configuredRelayUrl,
          relayIssuer: link.relayIssuer,
          cloudUserId: link.cloudUserId,
          environmentCredential: link.environmentCredential,
          cloudMintPublicKey: link.cloudMintPublicKey,
          endpointRuntime: link.endpointRuntime,
        },
      })
      .pipe(Effect.mapError(environmentApiError("Could not configure environment relay access.")));
  });
}

export function linkPrimaryEnvironmentToCloud(input: {
  readonly clerkToken: string;
}): Effect.Effect<void, CloudEnvironmentLinkError, HttpClient.HttpClient | ManagedRelayClient> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "T3CODE_RELAY_URL is not configured.",
      });
    }
    const relayClient = yield* ManagedRelayClient;
    const target = readPrimaryCloudLinkTarget();
    if (!target) {
      return yield* new CloudEnvironmentLinkError({
        message: "Local environment is not ready yet.",
      });
    }
    const environmentClient = yield* makeEnvironmentHttpApiClient(target.httpBaseUrl);
    yield* ensureRelayClientAvailable(getPrimaryEnvironmentConnection().client);

    const challenge = yield* relayClient
      .createEnvironmentLinkChallenge({
        clerkToken: input.clerkToken,
        payload: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(
            `${configuredRelayUrl}/v1/client/environment-link-challenges failed`,
          ),
        ),
      );
    const proof = yield* environmentClient.connect
      .linkProof({
        headers: {},
        payload: {
          challenge: challenge.challenge,
          relayIssuer: configuredRelayUrl,
          endpoint: {
            httpBaseUrl: target.httpBaseUrl,
            wsBaseUrl: target.wsBaseUrl,
            providerKind: MANAGED_ENDPOINT_PROVIDER_KIND,
          },
          origin: endpointOrigin(target.httpBaseUrl),
        },
      })
      .pipe(
        withPrimaryEnvironmentRequestInit,
        Effect.mapError(environmentApiError("Could not obtain environment link proof.")),
      );
    const link = yield* relayClient
      .linkEnvironment({
        clerkToken: input.clerkToken,
        payload: {
          proof,
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(`${configuredRelayUrl}/v1/client/environment-links failed`),
        ),
      );
    yield* ensureLinkedEnvironmentMatches({
      expectedEnvironmentId: target.environmentId,
      expectedProviderKind: MANAGED_ENDPOINT_PROVIDER_KIND,
      link,
    });

    yield* environmentClient.connect
      .relayConfig({
        headers: {},
        payload: {
          relayUrl: configuredRelayUrl,
          relayIssuer: link.relayIssuer,
          cloudUserId: link.cloudUserId,
          environmentCredential: link.environmentCredential,
          cloudMintPublicKey: link.cloudMintPublicKey,
          endpointRuntime: link.endpointRuntime,
        },
      })
      .pipe(
        withPrimaryEnvironmentRequestInit,
        Effect.mapError(environmentApiError("Could not configure environment relay access.")),
      );
  });
}
