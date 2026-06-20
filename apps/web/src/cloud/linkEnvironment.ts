import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
  WS_METHODS,
} from "@t3tools/contracts";
import {
  type RelayClientDeviceRecord,
  type RelayClientEnvironmentRecord,
  type RelayEnvironmentLinkResponse,
  type RelayManagedEndpointProviderKind,
  RelayProtectedError,
} from "@t3tools/contracts/relay";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request, runStream } from "@t3tools/client-runtime/rpc";
import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";

import {
  readPrimaryEnvironmentDescriptor,
  readPrimaryEnvironmentTarget,
} from "../environments/primary";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
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

const EnvironmentCloudApiError = Schema.Union([
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentCloudEndpointUnavailableError,
]);
type EnvironmentCloudApiError = typeof EnvironmentCloudApiError.Type;
const isEnvironmentCloudApiError = Schema.is(EnvironmentCloudApiError);

function relayUrlDiagnosticFields(relayUrl: string | undefined) {
  if (relayUrl === undefined) return {};
  const diagnostics = getUrlDiagnostics(relayUrl);
  return {
    relayUrlInputLength: diagnostics.inputLength,
    ...(diagnostics.protocol === undefined ? {} : { relayUrlProtocol: diagnostics.protocol }),
    ...(diagnostics.hostname === undefined ? {} : { relayUrlHostname: diagnostics.hostname }),
  };
}

function httpBaseUrlDiagnosticFields(httpBaseUrl: string | undefined) {
  if (httpBaseUrl === undefined) return {};
  const diagnostics = getUrlDiagnostics(httpBaseUrl);
  return {
    httpBaseUrlInputLength: diagnostics.inputLength,
    ...(diagnostics.protocol === undefined ? {} : { httpBaseUrlProtocol: diagnostics.protocol }),
    ...(diagnostics.hostname === undefined ? {} : { httpBaseUrlHostname: diagnostics.hostname }),
  };
}

export const CloudEnvironmentLinkAction = Schema.Literals([
  "check relay client availability",
  "confirm relay client installation",
  "install the relay client",
  "list relay-managed environments",
  "list cloud devices",
  "read environment cloud link state",
  "update environment cloud preferences",
  "unlink the environment from cloud",
  "revoke the cloud environment link",
  "create an environment link challenge",
  "obtain an environment link proof",
  "link the environment",
  "derive the environment endpoint origin",
  "initialize the environment HTTP client",
  "configure environment relay access",
]);
export type CloudEnvironmentLinkAction = typeof CloudEnvironmentLinkAction.Type;

export class CloudEnvironmentLinkOperationError extends Schema.TaggedErrorClass<CloudEnvironmentLinkOperationError>()(
  "CloudEnvironmentLinkOperationError",
  {
    action: CloudEnvironmentLinkAction,
    environmentId: Schema.optionalKey(Schema.String),
    relayUrlInputLength: Schema.optionalKey(Schema.Number),
    relayUrlProtocol: Schema.optionalKey(Schema.String),
    relayUrlHostname: Schema.optionalKey(Schema.String),
    httpBaseUrlInputLength: Schema.optionalKey(Schema.Number),
    httpBaseUrlProtocol: Schema.optionalKey(Schema.String),
    httpBaseUrlHostname: Schema.optionalKey(Schema.String),
    traceId: Schema.optionalKey(Schema.String),
    relayError: Schema.optionalKey(RelayProtectedError),
    environmentError: Schema.optionalKey(EnvironmentCloudApiError),
    cause: Schema.Defect(),
  },
) {
  static fromManagedRelay(input: {
    readonly action: CloudEnvironmentLinkAction;
    readonly cause: ManagedRelay.ManagedRelayClientError;
    readonly environmentId?: string;
    readonly relayUrl?: string;
    readonly httpBaseUrl?: string;
  }): CloudEnvironmentLinkOperationError {
    const requestFailure =
      input.cause._tag === "ManagedRelayRequestFailedError" ? input.cause : undefined;
    return new CloudEnvironmentLinkOperationError({
      action: input.action,
      cause: input.cause,
      ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
      ...relayUrlDiagnosticFields(input.relayUrl),
      ...httpBaseUrlDiagnosticFields(input.httpBaseUrl),
      ...(requestFailure?.traceId === undefined ? {} : { traceId: requestFailure.traceId }),
      ...(requestFailure?.relayError === undefined
        ? {}
        : { relayError: requestFailure.relayError }),
    });
  }

  static fromEnvironmentApi(input: {
    readonly action: CloudEnvironmentLinkAction;
    readonly cause: unknown;
    readonly environmentId: string;
    readonly httpBaseUrl: string;
  }): CloudEnvironmentLinkOperationError {
    const environmentError = CloudEnvironmentLinkOperationError.findEnvironmentApiError(
      input.cause,
    );
    return new CloudEnvironmentLinkOperationError({
      action: input.action,
      environmentId: input.environmentId,
      ...httpBaseUrlDiagnosticFields(input.httpBaseUrl),
      cause: input.cause,
      ...(environmentError === undefined ? {} : { environmentError }),
    });
  }

  private static findEnvironmentApiError(cause: unknown): EnvironmentCloudApiError | undefined {
    const seen = new Set<unknown>();
    let current = cause;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      if (isEnvironmentCloudApiError(current)) {
        return current;
      }
      seen.add(current);
      current = "cause" in current ? current.cause : undefined;
    }
    return undefined;
  }

  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment "${this.environmentId}"`;
    return `Could not ${this.action}${environment}.`;
  }
}

export class CloudRelayUrlNotConfiguredError extends Schema.TaggedErrorClass<CloudRelayUrlNotConfiguredError>()(
  "CloudRelayUrlNotConfiguredError",
  { environmentId: Schema.optionalKey(Schema.String) },
) {
  override get message(): string {
    return "T3CODE_RELAY_URL is not configured.";
  }
}

export class CloudRelayClientInstallUnsupportedError extends Schema.TaggedErrorClass<CloudRelayClientInstallUnsupportedError>()(
  "CloudRelayClientInstallUnsupportedError",
  {
    environmentId: Schema.String,
    phase: Schema.Literals(["preflight", "post-install"]),
    version: Schema.String,
    platform: Schema.String,
    architecture: Schema.String,
  },
) {
  override get message(): string {
    return `T3 Code cannot install the relay client automatically on ${this.platform}-${this.architecture}.`;
  }
}

export class CloudRelayClientInstallCancelledError extends Schema.TaggedErrorClass<CloudRelayClientInstallCancelledError>()(
  "CloudRelayClientInstallCancelledError",
  {
    environmentId: Schema.String,
    version: Schema.String,
  },
) {
  override get message(): string {
    return "Relay client installation was cancelled.";
  }
}

export class CloudRelayClientInstallIncompleteError extends Schema.TaggedErrorClass<CloudRelayClientInstallIncompleteError>()(
  "CloudRelayClientInstallIncompleteError",
  {
    environmentId: Schema.String,
    version: Schema.String,
  },
) {
  override get message(): string {
    return "The relay client install completed without a final status.";
  }
}

export class CloudRelayClientUnavailableAfterInstallError extends Schema.TaggedErrorClass<CloudRelayClientUnavailableAfterInstallError>()(
  "CloudRelayClientUnavailableAfterInstallError",
  {
    environmentId: Schema.String,
    version: Schema.String,
  },
) {
  override get message(): string {
    return "The relay client is still unavailable after installation.";
  }
}

export class CloudEnvironmentLinkResponseMismatchError extends Schema.TaggedErrorClass<CloudEnvironmentLinkResponseMismatchError>()(
  "CloudEnvironmentLinkResponseMismatchError",
  {
    environmentId: Schema.String,
    field: Schema.Literals(["environment id", "endpoint provider"]),
    expected: Schema.String,
    actual: Schema.String,
  },
) {
  override get message(): string {
    return `Relay returned link credentials with an unexpected ${this.field}.`;
  }
}

export const CloudEnvironmentLinkError = Schema.Union([
  CloudEnvironmentLinkOperationError,
  CloudRelayUrlNotConfiguredError,
  CloudRelayClientInstallUnsupportedError,
  CloudRelayClientInstallCancelledError,
  CloudRelayClientInstallIncompleteError,
  CloudRelayClientUnavailableAfterInstallError,
  CloudEnvironmentLinkResponseMismatchError,
]);
export type CloudEnvironmentLinkError = typeof CloudEnvironmentLinkError.Type;
export const isCloudEnvironmentLinkError = Schema.is(CloudEnvironmentLinkError);

function ensureRelayClientAvailable(
  environmentId: EnvironmentId,
): Effect.Effect<void, CloudEnvironmentLinkError, EnvironmentRegistry> {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const status = yield* registry
      .run(environmentId, request(WS_METHODS.cloudGetRelayClientStatus, {}))
      .pipe(
        Effect.mapError(
          (cause) =>
            new CloudEnvironmentLinkOperationError({
              action: "check relay client availability",
              environmentId,
              cause,
            }),
        ),
      );
    if (status.status === "available") return;
    if (status.status === "unsupported") {
      return yield* new CloudRelayClientInstallUnsupportedError({
        environmentId,
        phase: "preflight",
        version: status.version,
        platform: status.platform,
        architecture: status.arch,
      });
    }

    const confirmed = yield* Effect.tryPromise({
      try: () => requestRelayClientInstallConfirmation(status.version),
      catch: (cause) =>
        new CloudEnvironmentLinkOperationError({
          action: "confirm relay client installation",
          environmentId,
          cause,
        }),
    });
    if (!confirmed) {
      return yield* new CloudRelayClientInstallCancelledError({
        environmentId,
        version: status.version,
      });
    }

    const installed = yield* registry
      .runStream(
        environmentId,
        runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
          Stream.tap((event) => Effect.sync(() => reportRelayClientInstallProgress(event))),
        ),
      )
      .pipe(
        Stream.runLast,
        Effect.mapError(
          (cause) =>
            new CloudEnvironmentLinkOperationError({
              action: "install the relay client",
              environmentId,
              cause,
            }),
        ),
        Effect.ensuring(Effect.sync(finishRelayClientInstall)),
      );
    if (Option.isNone(installed) || installed.value.type !== "complete") {
      return yield* new CloudRelayClientInstallIncompleteError({
        environmentId,
        version: status.version,
      });
    }
    const installedStatus = installed.value.status;
    if (installedStatus.status !== "available") {
      return yield* installedStatus.status === "unsupported"
        ? new CloudRelayClientInstallUnsupportedError({
            environmentId,
            phase: "post-install",
            version: installedStatus.version,
            platform: installedStatus.platform,
            architecture: installedStatus.arch,
          })
        : new CloudRelayClientUnavailableAfterInstallError({
            environmentId,
            version: installedStatus.version,
          });
    }
  });
}

function endpointOrigin(input: { readonly environmentId: string; readonly httpBaseUrl: string }) {
  return Effect.try({
    try: () => {
      const url = new URL(input.httpBaseUrl);
      return {
        localHttpHost: "127.0.0.1",
        localHttpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      };
    },
    catch: (cause) =>
      new CloudEnvironmentLinkOperationError({
        action: "derive the environment endpoint origin",
        environmentId: input.environmentId,
        ...httpBaseUrlDiagnosticFields(input.httpBaseUrl),
        cause,
      }),
  });
}

function makeCloudEnvironmentHttpApiClient(input: {
  readonly environmentId: string;
  readonly httpBaseUrl: string;
}) {
  return Effect.try({
    try: () => makeEnvironmentHttpApiClient(input.httpBaseUrl),
    catch: (cause) =>
      new CloudEnvironmentLinkOperationError({
        action: "initialize the environment HTTP client",
        environmentId: input.environmentId,
        ...httpBaseUrlDiagnosticFields(input.httpBaseUrl),
        cause,
      }),
  }).pipe(Effect.flatten);
}

const MANAGED_ENDPOINT_PROVIDER_KIND =
  "cloudflare_tunnel" satisfies RelayManagedEndpointProviderKind;

function ensureLinkedEnvironmentMatches(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponse;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (input.link.environmentId !== input.expectedEnvironmentId) {
    return new CloudEnvironmentLinkResponseMismatchError({
      environmentId: input.expectedEnvironmentId,
      field: "environment id",
      expected: input.expectedEnvironmentId,
      actual: input.link.environmentId,
    });
  }
  if (input.link.endpoint.providerKind !== input.expectedProviderKind) {
    return new CloudEnvironmentLinkResponseMismatchError({
      environmentId: input.expectedEnvironmentId,
      field: "endpoint provider",
      expected: input.expectedProviderKind,
      actual: input.link.endpoint.providerKind,
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
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudRelayUrlNotConfiguredError({});
    }
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    return yield* relayClient
      .listEnvironments({
        clerkToken: input.clerkToken,
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromManagedRelay({
            action: "list relay-managed environments",
            relayUrl: configuredRelayUrl,
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
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudRelayUrlNotConfiguredError({});
    }
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    return yield* relayClient.listDevices({ clerkToken: input.clerkToken }).pipe(
      Effect.mapError((cause) =>
        CloudEnvironmentLinkOperationError.fromManagedRelay({
          action: "list cloud devices",
          relayUrl: configuredRelayUrl,
          cause,
        }),
      ),
    );
  });
}

export function readPrimaryCloudLinkState(input: {
  readonly target: CloudLinkTarget;
}): Effect.Effect<CloudLinkState | null, CloudEnvironmentLinkError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* makeCloudEnvironmentHttpApiClient({
      environmentId: input.target.environmentId,
      httpBaseUrl: input.target.httpBaseUrl,
    });
    return yield* client.connect.linkState({ headers: {} }).pipe(
      Effect.mapError((cause) =>
        CloudEnvironmentLinkOperationError.fromEnvironmentApi({
          action: "read environment cloud link state",
          environmentId: input.target.environmentId,
          httpBaseUrl: input.target.httpBaseUrl,
          cause,
        }),
      ),
    );
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer));
}

export function updatePrimaryCloudPreferences(input: {
  readonly target: CloudLinkTarget;
  readonly publishAgentActivity: boolean;
}): Effect.Effect<CloudLinkState, CloudEnvironmentLinkError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* makeCloudEnvironmentHttpApiClient({
      environmentId: input.target.environmentId,
      httpBaseUrl: input.target.httpBaseUrl,
    });
    return yield* client.connect
      .preferences({
        headers: {},
        payload: input,
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromEnvironmentApi({
            action: "update environment cloud preferences",
            environmentId: input.target.environmentId,
            httpBaseUrl: input.target.httpBaseUrl,
            cause,
          }),
        ),
      );
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer));
}

export function unlinkPrimaryEnvironmentFromCloud(input: {
  readonly target: CloudLinkTarget;
  readonly clerkToken: string | null;
}): Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const client = yield* makeCloudEnvironmentHttpApiClient({
      environmentId: input.target.environmentId,
      httpBaseUrl: input.target.httpBaseUrl,
    });
    yield* client.connect.unlink({ headers: {} }).pipe(
      Effect.mapError((cause) =>
        CloudEnvironmentLinkOperationError.fromEnvironmentApi({
          action: "unlink the environment from cloud",
          environmentId: input.target.environmentId,
          httpBaseUrl: input.target.httpBaseUrl,
          cause,
        }),
      ),
    );

    const configuredRelayUrl = relayUrl();
    if (configuredRelayUrl && input.clerkToken) {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient
        .unlinkEnvironment({
          clerkToken: input.clerkToken,
          environmentId: EnvironmentId.make(input.target.environmentId),
        })
        .pipe(
          Effect.catch((cause) => {
            const error = CloudEnvironmentLinkOperationError.fromManagedRelay({
              action: "revoke the cloud environment link",
              environmentId: input.target.environmentId,
              relayUrl: configuredRelayUrl,
              cause,
            });
            return Effect.logWarning(error.message, {
              environmentId: input.target.environmentId,
              relayUrl: configuredRelayUrl,
              cause: error,
            });
          }),
        );
    }
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer));
}

export function linkPrimaryEnvironmentToCloud(input: {
  readonly target: CloudLinkTarget;
  readonly clerkToken: string;
}): Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  EnvironmentRegistry | HttpClient.HttpClient | ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudRelayUrlNotConfiguredError({
        environmentId: input.target.environmentId,
      });
    }
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    yield* ensureRelayClientAvailable(EnvironmentId.make(input.target.environmentId));

    const origin = yield* endpointOrigin({
      environmentId: input.target.environmentId,
      httpBaseUrl: input.target.httpBaseUrl,
    });
    const environmentClient = yield* makeCloudEnvironmentHttpApiClient({
      environmentId: input.target.environmentId,
      httpBaseUrl: input.target.httpBaseUrl,
    });

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
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromManagedRelay({
            action: "create an environment link challenge",
            environmentId: input.target.environmentId,
            relayUrl: configuredRelayUrl,
            cause,
          }),
        ),
      );
    const proof = yield* environmentClient.connect
      .linkProof({
        headers: {},
        payload: {
          challenge: challenge.challenge,
          relayIssuer: configuredRelayUrl,
          endpoint: {
            httpBaseUrl: input.target.httpBaseUrl,
            wsBaseUrl: input.target.wsBaseUrl,
            providerKind: MANAGED_ENDPOINT_PROVIDER_KIND,
          },
          origin,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromEnvironmentApi({
            action: "obtain an environment link proof",
            environmentId: input.target.environmentId,
            httpBaseUrl: input.target.httpBaseUrl,
            cause,
          }),
        ),
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
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromManagedRelay({
            action: "link the environment",
            environmentId: input.target.environmentId,
            relayUrl: configuredRelayUrl,
            cause,
          }),
        ),
      );
    yield* ensureLinkedEnvironmentMatches({
      expectedEnvironmentId: input.target.environmentId,
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
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromEnvironmentApi({
            action: "configure environment relay access",
            environmentId: input.target.environmentId,
            httpBaseUrl: input.target.httpBaseUrl,
            cause,
          }),
        ),
      );
  }).pipe(Effect.provide(primaryEnvironmentHttpLayer));
}
