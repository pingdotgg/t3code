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
import {
  type RelayEnvironmentLinkResponse as RelayEnvironmentLinkResponseType,
  type RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay, relayProtectedErrorMessage } from "@t3tools/client-runtime/relay";
import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";

import type { SavedRemoteConnection } from "../../lib/connection";
import * as MobileStorage from "../../persistence/mobile-storage";
import { resolveCloudPublicConfig } from "./publicConfig";

function readRelayUrl(): string | null {
  return resolveCloudPublicConfig().relay.url;
}

export class CloudEnvironmentLinkError extends Data.TaggedError("CloudEnvironmentLinkError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly traceId?: string;
}> {}

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
    const traceId = findErrorTraceId(cause);
    const detail = environmentError
      ? `${message.replace(/[.:]$/, "")}: ${environmentError.message}`
      : withDevCause(message, cause);
    return new CloudEnvironmentLinkError({
      message: detail,
      cause,
      ...(traceId === null ? {} : { traceId }),
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

function decodedRelayClientError(message: string) {
  return (cause: ManagedRelay.ManagedRelayClientError) => {
    const relayError =
      cause._tag === "ManagedRelayRequestFailedError" ? cause.relayError : undefined;
    const traceId = cause._tag === "ManagedRelayRequestFailedError" ? cause.traceId : undefined;
    const detail = relayError ? relayProtectedErrorMessage(relayError) : null;
    return new CloudEnvironmentLinkError({
      message: detail ? `${message}: ${detail}` : message,
      cause,
      ...(traceId ? { traceId } : {}),
    });
  };
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

interface LinkEnvironmentToCloudInput {
  readonly connection: SavedRemoteConnection;
  readonly clerkToken: string;
}

type LinkEnvironmentToCloudRequirements =
  | HttpClient.HttpClient
  | ManagedRelay.ManagedRelayClient
  | MobileStorage.MobileStorage;

export function linkEnvironmentToCloudWithPreference(
  input: LinkEnvironmentToCloudInput & { readonly liveActivitiesEnabled: boolean },
): Effect.Effect<void, CloudEnvironmentLinkError, LinkEnvironmentToCloudRequirements> {
  return Effect.gen(function* () {
    if (!input.connection.bearerToken) {
      return yield* new CloudEnvironmentLinkError({
        message: "Only a locally paired bearer connection can be linked to the cloud.",
      });
    }
    const localBearerToken = input.connection.bearerToken;
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    const storage = yield* MobileStorage.MobileStorage;
    const deviceId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
      Effect.mapError(cloudEnvironmentLinkError("Could not load the mobile device id.")),
    );
    const liveActivitiesEnabled = input.liveActivitiesEnabled;
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
    const proof = yield* environmentClient.connect
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

    yield* environmentClient.connect
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
