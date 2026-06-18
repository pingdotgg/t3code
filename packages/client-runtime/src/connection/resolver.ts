import { RelayEnvironmentConnectScope } from "@t3tools/contracts/relay";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayClient } from "../relay/managedRelay.ts";
import {
  CloudSession,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  ConnectionCredentialStore,
  ConnectionProfileStore,
  SshConnectionProfile,
} from "./catalog.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapManagedRelayError,
  profileMissingError,
} from "./errors.ts";
import type {
  BearerConnectionTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(target: PrimaryConnectionTarget): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url.toString();
}

const primaryBroker = Effect.fn("clientRuntime.connection.broker.primary")(
  (target: PrimaryConnectionTarget) =>
    Effect.succeed({
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: primarySocketUrl(target),
      httpAuthorization: null,
      target,
    } satisfies PreparedConnection),
);

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Option.match(entry.profile, {
      onNone: () => Effect.fail(profileMissingError(target.connectionId)),
      onSome: Effect.succeed,
    });
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        message: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    const credential = yield* credentials.get(target.connectionId).pipe(
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
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

const makeRelayBroker = Effect.fn("clientRuntime.connection.broker.makeRelay")(function* () {
  const relay = yield* ManagedRelayClient;
  const session = yield* CloudSession;
  const identity = yield* RelayDeviceIdentity;
  const remote = yield* RemoteEnvironmentAuthorization;

  return Effect.fnUntraced(
    function* (target: RelayConnectionTarget) {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
        obtainBootstrap: Effect.gen(function* () {
          const clerkToken = yield* session.clerkToken.pipe(
            Effect.withSpan("relay.connection.cloudSessionToken.resolve"),
          );
          const deviceId = yield* identity.deviceId.pipe(
            Effect.withSpan("relay.connection.deviceIdentity.resolve"),
          );
          const connected = yield* relay
            .connectEnvironment({
              clerkToken,
              scopes: [RelayEnvironmentConnectScope],
              environmentId: target.environmentId,
              ...(Option.isSome(deviceId) ? { deviceId: deviceId.value } : {}),
            })
            .pipe(Effect.mapError(mapManagedRelayError));
          if (connected.environmentId !== target.environmentId) {
            return yield* environmentMismatchError({
              expected: target.environmentId,
              actual: connected.environmentId,
            });
          }
          return connected;
        }).pipe(Effect.withSpan("relay.connection.bootstrap.obtain")),
      });
      return {
        environmentId: authorized.environmentId,
        label: authorized.label,
        httpBaseUrl: authorized.httpBaseUrl,
        socketUrl: authorized.socketUrl,
        httpAuthorization: authorized.httpAuthorization,
        target,
      } satisfies PreparedConnection;
    },
    Effect.withSpan("clientRuntime.connection.broker.relay"),
    withRelayClientTracing,
  );
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(function* () {
  const profiles = yield* ConnectionProfileStore;
  const ssh = yield* SshEnvironmentGateway;
  const remote = yield* RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.ssh")(function* (
    entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Option.match(entry.profile, {
      onNone: () => Effect.fail(profileMissingError(target.connectionId)),
      onSome: Effect.succeed,
    });
    if (!isSshProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        message: `Connection profile ${target.connectionId} is not an SSH connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    const prepared = yield* ssh.prepare({
      connectionId: target.connectionId,
      expectedEnvironmentId: target.environmentId,
      target: profile.target,
    });
    yield* profiles.put(
      new SshConnectionProfile({
        connectionId: profile.connectionId,
        environmentId: profile.environmentId,
        label: profile.label,
        target: prepared.bootstrap.target,
      }),
    );
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: prepared.bootstrap.httpBaseUrl,
      wsBaseUrl: prepared.bootstrap.wsBaseUrl,
      bearerToken: prepared.bearerToken,
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

export const connectionResolverLayer = Layer.effect(
  ConnectionResolver,
  Effect.gen(function* () {
    const bearer = yield* makeBearerBroker();
    const relay = yield* makeRelayBroker();
    const ssh = yield* makeSshBroker();

    const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
      entry: ConnectionCatalogEntry,
    ) {
      const target: ConnectionTarget = entry.target;
      yield* Effect.annotateCurrentSpan({
        "connection.environment.id": target.environmentId,
        "connection.target.kind": target._tag,
      });
      switch (target._tag) {
        case "PrimaryConnectionTarget":
          return yield* primaryBroker(target);
        case "BearerConnectionTarget":
          return yield* bearer({ ...entry, target });
        case "RelayConnectionTarget":
          return yield* relay(target);
        case "SshConnectionTarget":
          return yield* ssh({ ...entry, target });
      }
    });

    return ConnectionResolver.of({ prepare });
  }),
);
