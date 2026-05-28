import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentLinkProof,
  RelayLinkProofRequest,
  type RelayEnvironmentLinkResponse,
  RelayProtectedError,
  type RelayClientEnvironmentRecord,
  type RelayProtectedError as RelayProtectedErrorType,
  type RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import {
  exchangeRemoteDpopAccessToken,
  fetchRemoteEnvironmentDescriptor,
  ManagedRelayClient,
  ManagedRelayDpopSigner,
} from "@t3tools/client-runtime";

import { ensureLocalApi } from "../localApi";
import type { SavedEnvironmentRecord } from "../environments/runtime";
import {
  readPrimaryEnvironmentDescriptor,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "../environments/primary";

export function normalizeRelayBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function relayUrl(): string | null {
  return normalizeRelayBaseUrl(import.meta.env.VITE_T3_RELAY_URL as string | undefined);
}

export class CloudEnvironmentLinkError extends Data.TaggedError("CloudEnvironmentLinkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const encodeRelayLinkProofRequest = Schema.encodeEffect(
  Schema.fromJsonString(RelayLinkProofRequest),
);
const encodeRelayEnvironmentConfigRequest = Schema.encodeEffect(
  Schema.fromJsonString(RelayEnvironmentConfigRequest),
);
const decodeRelayProtectedError = Schema.decodeUnknownEffect(RelayProtectedError);

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
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  if ("_tag" in cause && String(cause._tag).startsWith("Relay")) {
    return cause as RelayProtectedErrorType;
  }
  return "cause" in cause ? findRelayProtectedError(cause.cause) : null;
}

function requestFromInit(url: string, init: RequestInit) {
  return HttpClientRequest.make((init.method ?? "GET") as "GET" | "POST" | "DELETE")(url, {
    headers: init.headers as Record<string, string> | undefined,
  }).pipe(
    typeof init.body === "string"
      ? HttpClientRequest.bodyText(
          init.body,
          (init.headers as Record<string, string> | undefined)?.["content-type"] ??
            "application/json",
        )
      : (request) => request,
  );
}

function jsonResponse(
  url: string,
  init: RequestInit,
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const execute = HttpClient.execute(requestFromInit(url, init));
    const response = yield* (
      init.credentials === undefined
        ? execute
        : execute.pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { credentials: init.credentials }),
          )
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: `${url} request failed.`,
            cause,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const relayError = yield* response.json.pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((json) =>
          json === null
            ? Effect.succeed(null)
            : decodeRelayProtectedError(json).pipe(Effect.catch(() => Effect.succeed(null))),
        ),
      );
      return yield* new CloudEnvironmentLinkError({
        message: relayError
          ? `${url} failed with ${response.status}: ${relayProtectedErrorMessage(relayError)}`
          : `${url} failed with ${response.status}`,
      });
    }
    return response;
  });
}

function jsonFetch<T>(
  url: string,
  init: RequestInit,
): Effect.Effect<T, CloudEnvironmentLinkError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const response = yield* jsonResponse(url, init);
    return yield* response.json.pipe(
      Effect.map((json) => json as T),
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: `${url} returned invalid JSON.`,
            cause,
          }),
      ),
    );
  });
}

function jsonFetchSchema<S extends Schema.Top>(input: {
  readonly url: string;
  readonly init: RequestInit;
  readonly schema: S;
  readonly errorMessage: string;
}): Effect.Effect<
  S["Type"],
  CloudEnvironmentLinkError,
  S["DecodingServices"] | HttpClient.HttpClient
> {
  return jsonResponse(input.url, input.init).pipe(
    Effect.flatMap(HttpClientResponse.schemaJson(Schema.Struct({ body: input.schema }))),
    Effect.map((response) => (response as { readonly body: S["Type"] }).body),
    Effect.mapError((cause) =>
      cause instanceof CloudEnvironmentLinkError
        ? cause
        : new CloudEnvironmentLinkError({ message: input.errorMessage, cause }),
    ),
  );
}

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

export const CloudLinkState = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
});
export type CloudLinkState = typeof CloudLinkState.Type;

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
        message: "VITE_T3_RELAY_URL is not configured.",
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
        message: "VITE_T3_RELAY_URL is not configured.",
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
        url: new URL("/api/auth/token", connected.endpoint.httpBaseUrl).toString(),
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
    return yield* jsonFetchSchema({
      url: resolvePrimaryEnvironmentHttpUrl("/api/cloud/link-state"),
      schema: CloudLinkState,
      errorMessage: "Environment returned an invalid cloud link state.",
      init: {
        method: "GET",
        credentials: "include",
      },
    });
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
            Effect.logWarning("Could not revoke cloud environment link before local unlink.", {
              cause,
            }),
          ),
        );
    }

    yield* jsonFetch(resolvePrimaryEnvironmentHttpUrl("/api/cloud/unlink"), {
      method: "POST",
      credentials: "include",
    });
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
        message: "VITE_T3_RELAY_URL is not configured.",
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
    const proofRequestBody = yield* encodeRelayLinkProofRequest({
      challenge: challenge.challenge,
      relayIssuer: configuredRelayUrl,
      endpoint: {
        httpBaseUrl: input.environment.httpBaseUrl,
        wsBaseUrl: input.environment.wsBaseUrl,
        providerKind: MANAGED_ENDPOINT_PROVIDER_KIND,
      },
      origin: endpointOrigin(input.environment.httpBaseUrl),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: "Could not encode cloud link proof request.",
            cause,
          }),
      ),
    );
    const proof = yield* jsonFetchSchema({
      url: `${input.environment.httpBaseUrl}/api/cloud/link-proof`,
      schema: RelayEnvironmentLinkProof,
      errorMessage: "Environment returned an invalid cloud link proof.",
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        body: proofRequestBody,
      },
    });
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

    const relayConfigRequestBody = yield* encodeRelayEnvironmentConfigRequest({
      relayUrl: configuredRelayUrl,
      relayIssuer: link.relayIssuer,
      cloudUserId: link.cloudUserId,
      environmentCredential: link.environmentCredential,
      cloudMintPublicKey: link.cloudMintPublicKey,
      endpointRuntime: link.endpointRuntime,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: "Could not encode cloud relay config request.",
            cause,
          }),
      ),
    );
    yield* jsonFetch(`${input.environment.httpBaseUrl}/api/cloud/relay-config`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "content-type": "application/json",
      },
      body: relayConfigRequestBody,
    });
  });
}

export function linkPrimaryEnvironmentToCloud(input: {
  readonly clerkToken: string;
}): Effect.Effect<void, CloudEnvironmentLinkError, HttpClient.HttpClient | ManagedRelayClient> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "VITE_T3_RELAY_URL is not configured.",
      });
    }
    const relayClient = yield* ManagedRelayClient;
    const target = readPrimaryCloudLinkTarget();
    if (!target) {
      return yield* new CloudEnvironmentLinkError({
        message: "Local environment is not ready yet.",
      });
    }

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
    const proofRequestBody = yield* encodeRelayLinkProofRequest({
      challenge: challenge.challenge,
      relayIssuer: configuredRelayUrl,
      endpoint: {
        httpBaseUrl: target.httpBaseUrl,
        wsBaseUrl: target.wsBaseUrl,
        providerKind: MANAGED_ENDPOINT_PROVIDER_KIND,
      },
      origin: endpointOrigin(target.httpBaseUrl),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: "Could not encode cloud link proof request.",
            cause,
          }),
      ),
    );
    const proof = yield* jsonFetchSchema({
      url: resolvePrimaryEnvironmentHttpUrl("/api/cloud/link-proof"),
      schema: RelayEnvironmentLinkProof,
      errorMessage: "Environment returned an invalid cloud link proof.",
      init: {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: proofRequestBody,
      },
    });
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

    const relayConfigRequestBody = yield* encodeRelayEnvironmentConfigRequest({
      relayUrl: configuredRelayUrl,
      relayIssuer: link.relayIssuer,
      cloudUserId: link.cloudUserId,
      environmentCredential: link.environmentCredential,
      cloudMintPublicKey: link.cloudMintPublicKey,
      endpointRuntime: link.endpointRuntime,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new CloudEnvironmentLinkError({
            message: "Could not encode cloud relay config request.",
            cause,
          }),
      ),
    );
    yield* jsonFetch(resolvePrimaryEnvironmentHttpUrl("/api/cloud/relay-config"), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: relayConfigRequestBody,
    });
  });
}
