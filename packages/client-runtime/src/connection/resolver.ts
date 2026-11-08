import type {
  AuthClientPresentationMetadata,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import {
  appendClientConnectionParams,
  type ClientOwnerParams,
  readClientOwnerParams,
} from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  CloudSandboxConnectionProfile,
  CloudSandboxConnectionCredential,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  profileMissingError,
} from "./errors.ts";
import {
  PullRequestRoutingPermissions,
  pullRequestRoutingConnectionKey,
} from "./pullRequestRoutingPermissions.ts";
import type {
  BearerConnectionTarget,
  CloudSandboxConnectionTarget,
  CloudSandboxControllerTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import { makeManagedCloudSandboxClient, managedCloudSandboxUrls } from "./managedCloudSandbox.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";
import { credentialConnectionId } from "./routes.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
    /**
     * Authorizes a socket without the orchestration protocol gate, for hosts
     * too old to connect normally. Only update RPCs may run over it.
     */
    readonly prepareForUpdate: (entry: ConnectionCatalogEntry) => Effect.Effect<
      {
        readonly prepared: PreparedConnection;
        readonly descriptor: ExecutionEnvironmentDescriptor;
      },
      ConnectionAttemptError
    >;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);
const isCloudSandboxProfile = Schema.is(CloudSandboxConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(
  target: PrimaryConnectionTarget,
  clientMetadata: AuthClientPresentationMetadata | undefined,
  owners: ClientOwnerParams,
): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  appendClientConnectionParams(url, clientMetadata, "direct", owners);
  return url.toString();
}

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
  ) {
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: primarySocketUrl(target, presentation.metadata, yield* readClientOwnerParams),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
      connectionMethod: "direct",
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    if (profile.authorization === "t3-connect") {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
        directEndpoint: { httpBaseUrl: profile.httpBaseUrl, wsBaseUrl: profile.wsBaseUrl },
      });
      return { ...authorized, target } satisfies PreparedConnection;
    }
    const credential = yield* credentials.get(credentialConnectionId(target.connectionId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!isBearerCredential(credential)) {
      return yield* credentialMissingError(target.connectionId);
    }
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: profile.httpBaseUrl,
      wsBaseUrl: profile.wsBaseUrl,
      bearerToken: credential.token,
      connectionMethod: "direct",
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

const makeRelayBroker = Effect.fn("clientRuntime.connection.broker.makeRelay")(function* () {
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fnUntraced(
    function* (target: RelayConnectionTarget) {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
      });
      return {
        ...authorized,
        target,
      } satisfies PreparedConnection;
    },
    Effect.withSpan("clientRuntime.connection.broker.relay"),
    withRelayClientTracing,
  );
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(function* () {
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.ssh")(function* (
    entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isSshProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    // Each pairing adds a session on the host, so connects reuse the saved token.
    const saved = Option.getOrUndefined(yield* credentials.get(target.connectionId));
    const savedToken = saved !== undefined && isBearerCredential(saved) ? saved.token : undefined;
    const prepared = yield* ssh.prepare({
      connectionId: target.connectionId,
      expectedEnvironmentId: target.environmentId,
      target: profile.target,
      ...(savedToken === undefined ? {} : { bearerToken: savedToken }),
    });
    if (prepared.bearerToken !== savedToken) {
      yield* credentials.put(
        target.connectionId,
        new BearerConnectionCredential({ token: prepared.bearerToken }),
      );
    }
    const preparedProfile = new SshConnectionProfile({
      connectionId: profile.connectionId,
      environmentId: profile.environmentId,
      label: profile.label,
      target: prepared.bootstrap.target,
    });
    if (
      pullRequestRoutingConnectionKey(entry) !==
      pullRequestRoutingConnectionKey({ ...entry, profile: Option.some(preparedProfile) })
    ) {
      const permissions = yield* PullRequestRoutingPermissions;
      yield* permissions.forget(target.environmentId);
    }
    yield* profiles.put(preparedProfile);
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: prepared.bootstrap.httpBaseUrl,
      wsBaseUrl: prepared.bootstrap.wsBaseUrl,
      bearerToken: prepared.bearerToken,
      connectionMethod: "ssh",
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

const makeCloudSandboxBroker = Effect.fn("clientRuntime.connection.broker.makeCloudSandbox")(
  function* (
    prepareController: (
      target: CloudSandboxControllerTarget,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>,
  ) {
    const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
    const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
    const operate = yield* makeManagedCloudSandboxClient;
    return Effect.fn("clientRuntime.connection.broker.cloudSandbox")(function* (
      entry: ConnectionCatalogEntry & { readonly target: CloudSandboxConnectionTarget },
    ) {
      const target = entry.target;
      const profile = yield* Effect.fromOption(entry.profile, () =>
        profileMissingError(target.connectionId),
      );
      if (!isCloudSandboxProfile(profile)) return yield* profileMissingError(target.connectionId);
      if (profile.environmentId !== target.environmentId)
        return yield* environmentMismatchError({
          expected: target.environmentId,
          actual: profile.environmentId,
        });
      const controller = yield* prepareController(profile.controller);
      const result = yield* operate(controller, {
        _tag: "connect",
        resourceId: profile.resourceId,
      });
      if (result._tag !== "connection")
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "The controller returned an unexpected sandbox connection response.",
        });
      if (result.connection.environmentId !== target.environmentId)
        return yield* environmentMismatchError({
          expected: target.environmentId,
          actual: result.connection.environmentId,
        });
      const urls = yield* managedCloudSandboxUrls(controller, result.connection);
      yield* credentials.put(
        target.connectionId,
        new CloudSandboxConnectionCredential({ token: result.connection.bearerToken }),
      );
      const authorized = yield* remote.authorizeBearer({
        expectedEnvironmentId: target.environmentId,
        ...urls,
        bearerToken: result.connection.bearerToken,
        connectionMethod: "cloud-sandbox",
      });
      return { ...authorized, target } satisfies PreparedConnection;
    });
  },
);

/** @public */
export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker();
  const relay = yield* makeRelayBroker();
  const ssh = yield* makeSshBroker();
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const prepareController = Effect.fn("clientRuntime.connection.prepareCloudController")(function* (
    target: CloudSandboxControllerTarget,
  ) {
    const profile =
      "connectionId" in target ? yield* profiles.get(target.connectionId) : Option.none();
    const entry = { target, profile, enabled: true };
    switch (target._tag) {
      case "PrimaryConnectionTarget":
        return yield* primary(target);
      case "BearerConnectionTarget":
        return yield* bearer({ ...entry, target });
      case "RelayConnectionTarget":
        return yield* relay(target);
      case "SshConnectionTarget":
        return yield* ssh({ ...entry, target });
    }
  });
  const cloudSandbox = yield* makeCloudSandboxBroker(prepareController);
  const httpClient = yield* HttpClient.HttpClient;

  const authorize = Effect.fn("clientRuntime.connection.broker.authorize")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    const authorized: PreparedConnection & {
      readonly descriptor?: ExecutionEnvironmentDescriptor;
    } = yield* (() => {
      switch (target._tag) {
        case "PrimaryConnectionTarget":
          return primary(target);
        case "BearerConnectionTarget":
          return bearer({ ...entry, target });
        case "RelayConnectionTarget":
          return relay(target);
        case "SshConnectionTarget":
          return ssh({ ...entry, target });
        case "CloudSandboxConnectionTarget":
          return cloudSandbox({ ...entry, target });
      }
    })();
    const { descriptor: authorizedDescriptor, ...prepared } = authorized;
    const descriptor =
      authorizedDescriptor ??
      (yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: prepared.httpBaseUrl,
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ));
    if (descriptor.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    return { prepared, descriptor };
  });

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const { prepared, descriptor } = yield* authorize(entry);
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      return yield* compatibilityError;
    }
    return {
      ...prepared,
      socketUrl: appendOrchestrationProtocol(prepared.socketUrl),
    };
  });

  return ConnectionResolver.of({ prepare, prepareForUpdate: authorize });
});

export const layer = Layer.effect(ConnectionResolver, make);
