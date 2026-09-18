import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { appendClientConnectionParams } from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  bearerRouteCandidates,
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
  GitHubRoutingPermissions,
  gitHubRoutingConnectionKey,
} from "./githubRoutingPermissions.ts";
import type {
  BearerConnectionTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { deriveWsBaseUrl } from "../environment/endpoint.ts";

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

function primarySocketUrl(
  target: PrimaryConnectionTarget,
  clientMetadata: AuthClientPresentationMetadata | undefined,
): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  appendClientConnectionParams(url, clientMetadata, "direct");
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
        socketUrl: primarySocketUrl(target, presentation.metadata),
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

/**
 * Picks the route to dial for a bearer profile. With several candidates every
 * route fetches the environment descriptor at once and the first one to answer
 * with the expected identity wins; the fastest answer is the best route this
 * device has right now. When no route answers the preferred route is returned
 * so authorization reports the failure exactly as a single-route profile would.
 */
const selectBearerRoute = Effect.fn("clientRuntime.connection.broker.selectBearerRoute")(function* (
  profile: BearerConnectionProfile,
) {
  const candidates = bearerRouteCandidates(profile);
  if (candidates.length === 1) return candidates[0]!;
  return yield* Effect.raceAll(
    candidates.map((httpBaseUrl) =>
      fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
        Effect.filterOrFail((descriptor) => descriptor.environmentId === profile.environmentId),
        Effect.as(httpBaseUrl),
      ),
    ),
  ).pipe(
    Effect.tap((httpBaseUrl) =>
      Effect.annotateCurrentSpan({ "connection.route.httpBaseUrl": httpBaseUrl }),
    ),
    Effect.orElseSucceed(() => profile.httpBaseUrl),
  );
});

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const httpClient = yield* HttpClient.HttpClient;

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
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
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
    const httpBaseUrl = yield* selectBearerRoute(profile).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl,
      wsBaseUrl:
        httpBaseUrl === profile.httpBaseUrl ? profile.wsBaseUrl : deriveWsBaseUrl(httpBaseUrl),
      bearerToken: credential.token,
      connectionMethod: "direct",
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
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fnUntraced(
    function* (target: RelayConnectionTarget) {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
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
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

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
        detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
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
    const preparedProfile = new SshConnectionProfile({
      connectionId: profile.connectionId,
      environmentId: profile.environmentId,
      label: profile.label,
      target: prepared.bootstrap.target,
    });
    if (
      gitHubRoutingConnectionKey(entry) !==
      gitHubRoutingConnectionKey({ ...entry, profile: Option.some(preparedProfile) })
    ) {
      const permissions = yield* GitHubRoutingPermissions;
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
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker();
  const relay = yield* makeRelayBroker();
  const ssh = yield* makeSshBroker();
  const httpClient = yield* HttpClient.HttpClient;

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    const prepared = yield* (() => {
      switch (target._tag) {
        case "PrimaryConnectionTarget":
          return primary(target);
        case "BearerConnectionTarget":
          return bearer({ ...entry, target });
        case "RelayConnectionTarget":
          return relay(target);
        case "SshConnectionTarget":
          return ssh({ ...entry, target });
      }
    })();
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: prepared.httpBaseUrl,
    }).pipe(
      Effect.mapError(mapRemoteEnvironmentError),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    if (descriptor.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      return yield* compatibilityError;
    }
    return { ...prepared, socketUrl: appendOrchestrationProtocol(prepared.socketUrl) };
  });

  return ConnectionResolver.of({ prepare });
});

export const layer = Layer.effect(ConnectionResolver, make);
