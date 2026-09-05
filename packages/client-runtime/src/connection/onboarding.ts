import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
}

export interface SshEnvironmentVariablesUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly environmentVariables?: DesktopSshEnvironmentTarget["environmentVariables"];
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateSshEnvironmentVariables: (
      input: SshEnvironmentVariablesUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    scopes: presentation.scopes,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const connectionId = `bearer:${descriptor.environmentId}`;

  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
});

export const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);

export const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target);
  const connectionId = `ssh:${provisioned.environmentId}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
  });
});

export const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

export const prepareSshEnvironmentVariablesUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshEnvironmentVariablesUpdate",
)(function* (options: {
  readonly input: SshEnvironmentVariablesUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === null ||
    entry.target._tag !== "SshConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isSshProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved SSH environments can update their local environment variables.",
    });
  }

  const profile = entry.profile.value;
  const { environmentVariables: _currentEnvironmentVariables, ...baseTarget } = profile.target;
  const target: DesktopSshEnvironmentTarget = {
    ...baseTarget,
    ...(options.input.environmentVariables === undefined
      ? {}
      : { environmentVariables: options.input.environmentVariables }),
  };

  return new SshConnectionRegistration({
    target: entry.target,
    profile: new SshConnectionProfile({
      connectionId: profile.connectionId,
      environmentId: profile.environmentId,
      label: profile.label,
      target,
    }),
  });
});

export const updateSshEnvironmentVariables = Effect.fn(
  "clientRuntime.connection.onboarding.updateSshEnvironmentVariables",
)(function* (input: SshEnvironmentVariablesUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  if (entry === undefined) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved SSH environments can update their local environment variables.",
    });
  }
  const registration = yield* prepareSshEnvironmentVariablesUpdate({
    input,
    entry: Option.some(entry),
  });
  const previousProfile = Option.getOrNull(entry.profile);
  if (previousProfile === null || !isSshProfile(previousProfile)) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved SSH environments can update their local environment variables.",
    });
  }
  const prepareTarget = (target: DesktopSshEnvironmentTarget) =>
    gateway
      .prepare({
        connectionId: registration.profile.connectionId,
        expectedEnvironmentId: registration.profile.environmentId,
        target,
      })
      .pipe(Effect.asVoid);
  let restoreError: ConnectionAttemptError | null = null;
  const restorePreviousTarget = prepareTarget(previousProfile.target).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        restoreError = error;
      }).pipe(
        Effect.andThen(
          Effect.logWarning("Could not restore the previous SSH environment after save failed.", {
            environmentId: input.environmentId,
            error,
          }),
        ),
      ),
    ),
  );
  yield* registry
    .registerIfCurrent(entry, registration, {
      beforeRegister: prepareTarget(registration.profile.target),
      onFailure: restorePreviousTarget,
    })
    .pipe(
      Effect.mapError((error) => {
        if (restoreError === null) {
          return error;
        }
        const recovery =
          "The saved settings are unchanged, but the previous SSH runtime could not be restored. Disconnect and reconnect this environment before continuing.";
        switch (error._tag) {
          case "ConnectionPersistenceError":
            return new Persistence.ConnectionPersistenceError({
              operation: error.operation,
              message: `${error.message} ${recovery}`,
            });
          case "ConnectionBlockedError":
            return new ConnectionBlockedError({
              reason: error.reason,
              detail: `${error.detail} ${recovery}`,
              ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
            });
          case "ConnectionTransientError":
            return new ConnectionTransientError({
              reason: error.reason,
              detail: `${error.detail} ${recovery}`,
              ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
            });
          case "EnvironmentNotRegisteredError":
            return error;
        }
      }),
      Effect.catchTags({
        EnvironmentNotRegisteredError: () =>
          new ConnectionBlockedError({
            reason: "configuration",
            detail: "The SSH environment was removed before the update could be saved.",
          }),
      }),
    );
});

export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

  return ConnectionOnboarding.of({
    registerPairing: (input) =>
      registerPairingConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    registerSsh: (input) =>
      registerSshConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    updateSshEnvironmentVariables: (input) =>
      updateSshEnvironmentVariables(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    updateBearer: (input) =>
      updateBearerConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
