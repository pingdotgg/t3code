import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  TailnetPeerEnvironment,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
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
  TailnetConnectionCredential,
  TailnetConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { connectionRoutes, routeEntry, routeHttpBaseUrl, sshTargetKey } from "./routes.ts";
import {
  machinesToAdd,
  supportsTailnetSignIn,
  TAILNET_SIGN_IN_PORT,
  tailnetSignInBaseUrl,
} from "./tailnet.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface TailnetConnectionInput {
  /** `studio`, `studio.tailnet.ts.net`, `100.x.y.z`, or the `t3 up` QR's plain URL. */
  readonly address: string;
  /** Adds the address as a route to this saved environment. */
  readonly expectedEnvironmentId?: EnvironmentId;
}

/** What one pass over machines found on the tailnet did. */
export interface TailnetDiscoveryResult {
  readonly added: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
  /** A saved environment answered at an address it was not saved with. */
  readonly conflicts: ReadonlyArray<{ readonly label: string; readonly address: string }>;
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
    /**
     * Signs in through Tailscale with no code. None when the machine does not
     * offer Tailscale sign-in, so the caller asks for a pairing code.
     */
    readonly registerTailnet: (
      input: TailnetConnectionInput,
    ) => Effect.Effect<
      Option.Option<EnvironmentId>,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    /** Adds found machines that offer Tailscale sign-in, skipping removed and saved ones. */
    readonly addDiscoveredTailnetMachines: (
      machines: ReadonlyArray<TailnetPeerEnvironment>,
    ) => Effect.Effect<TailnetDiscoveryResult>;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    // A bare tailnet name or 100.x address means T3 Code's port, with a code as without one.
    const tailnetHost = input.host === undefined ? null : tailnetSignInBaseUrl(input.host);
    return yield* Effect.try({
      try: () =>
        resolveRemotePairingTarget(tailnetHost === null ? input : { ...input, host: tailnetHost }),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

function bearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `That address reaches ${label}, a different machine. Add it as its own environment instead.`,
  });
}

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Checked before redeeming the one-time code, so a wrong link is not spent.
  if (
    input.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(descriptor.label);
  }
  const connectionId = bearerConnectionId(descriptor.environmentId, target.httpBaseUrl);
  const route = {
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
  };
  // The registry checks again under its lease; this early check keeps a refused code unspent.
  if (input.expectedEnvironmentId === undefined) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.assertKnownAddress({ ...route, profile: Option.some(route.profile) });
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  // An outdated server is still saved so it can be updated from this client.
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));

  return new BearerConnectionRegistration({
    ...route,
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const knownAddressOnly = input.expectedEnvironmentId === undefined;
  if (!(yield* registry.register(registration, { knownAddressOnly }))) {
    return registration.target.environmentId;
  }
  yield* registry.setCompatibility(registration.target.environmentId, null);
  yield* registry
    .setEnabled(registration.target.environmentId, true)
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  return registration.target.environmentId;
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isTailnetCredential = Schema.is(TailnetConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

// URL drops a default port, so `http://host:80/` and `http://host/` are one address.
const sameAddress = (a: string, b: string) => normalizeHttpBaseUrl(a) === normalizeHttpBaseUrl(b);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const route =
    saved === undefined
      ? undefined
      : connectionRoutes(saved).find(
          (candidate) => candidate.target._tag === "BearerConnectionTarget",
        );
  const entry = saved === undefined || route === undefined ? saved : routeEntry(saved, route);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  // A Tailscale session is pinned to where it signed in, so a new address signs in again.
  const signInBaseUrl = Option.exists(credential, isTailnetCredential)
    ? tailnetSignInBaseUrl(input.httpBaseUrl)
    : null;
  const savedHttpBaseUrl = entry === undefined ? null : routeHttpBaseUrl(entry);
  const signedIn =
    signInBaseUrl === null ||
    savedHttpBaseUrl === null ||
    sameAddress(signInBaseUrl, savedHttpBaseUrl)
      ? Option.none<TailnetConnectionRegistration>()
      : yield* prepareTailnetRegistration({
          httpBaseUrl: signInBaseUrl,
          expectedEnvironmentId: input.environmentId,
          joinsRoutes: true,
        });
  const registration = yield* prepareBearerConnectionUpdate({
    input: Option.match(signedIn, {
      onNone: () => (signInBaseUrl === null ? input : { ...input, httpBaseUrl: signInBaseUrl }),
      onSome: (fresh) => ({ ...input, httpBaseUrl: fresh.profile.httpBaseUrl }),
    }),
    entry: Option.fromUndefinedOr(entry),
    credential: Option.match(signedIn, {
      onNone: () => credential,
      onSome: (fresh) => Option.some<ConnectionCredential>(fresh.credential),
    }),
  });
  yield* registry.register(registration);
});

const DISCOVERY_PROBE_TIMEOUT_MS = 3_000;
const DISCOVERY_CONCURRENCY = 4;

export const prepareTailnetRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareTailnetRegistration",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly expectedEnvironmentId?: EnvironmentId;
  /** Only when the user picked the saved environment this address joins. */
  readonly joinsRoutes?: boolean;
  readonly timeoutMs?: number;
}) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: input.httpBaseUrl,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  if (
    input.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(descriptor.label);
  }
  if (descriptor.capabilities.tailnetSignIn !== true) {
    return Option.none<TailnetConnectionRegistration>();
  }
  const connectionId = `tailnet:${descriptor.environmentId}:${new URL(input.httpBaseUrl).origin}`;
  const route = {
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: input.httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(input.httpBaseUrl),
      authorization: "tailnet",
      network: "tailscale",
    }),
  };
  if (input.joinsRoutes !== true) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.assertKnownAddress({ ...route, profile: Option.some(route.profile) });
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const credential = yield* remote.signInTailnet({ httpBaseUrl: input.httpBaseUrl });
  return Option.some(new TailnetConnectionRegistration({ ...route, credential }));
});

const saveTailnetRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.saveTailnetRegistration",
)(function* (registration: TailnetConnectionRegistration, joinsRoutes: boolean) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const environmentId = registration.target.environmentId;
  // A found or typed address joins a saved environment only when the user picked it.
  if (!(yield* registry.register(registration, { knownAddressOnly: !joinsRoutes }))) {
    return environmentId;
  }
  yield* registry.setCompatibility(environmentId, null);
  yield* registry
    .setEnabled(environmentId, true)
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  return environmentId;
});

const registerTailnetConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerTailnetConnection",
)(function* (input: TailnetConnectionInput) {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpBaseUrl = tailnetSignInBaseUrl(input.address);
  if (httpBaseUrl === null || !supportsTailnetSignIn(presentation.metadata)) {
    return Option.none<EnvironmentId>();
  }
  const joinsRoutes = input.expectedEnvironmentId !== undefined;
  const registration = yield* prepareTailnetRegistration({
    httpBaseUrl,
    joinsRoutes,
    ...(input.expectedEnvironmentId === undefined
      ? {}
      : { expectedEnvironmentId: input.expectedEnvironmentId }),
  });
  if (Option.isNone(registration)) return Option.none<EnvironmentId>();
  return Option.some(yield* saveTailnetRegistration(registration.value, joinsRoutes));
});

const addDiscoveredTailnetMachines = Effect.fn(
  "clientRuntime.connection.onboarding.addDiscoveredTailnetMachines",
)(function* (machines: ReadonlyArray<TailnetPeerEnvironment>, unsaveable: Set<EnvironmentId>) {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  if (!supportsTailnetSignIn(presentation.metadata)) return { added: [], conflicts: [] };
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const { add, conflicts } = machinesToAdd({
    machines,
    entries: yield* SubscriptionRef.get(registry.entries),
    dismissed: yield* SubscriptionRef.get(registry.dismissedEnvironmentIds),
  });
  const added = yield* Effect.forEach(
    add.filter((machine) => !unsaveable.has(machine.environmentId)),
    (machine) =>
      prepareTailnetRegistration({
        httpBaseUrl: `http://${machine.tailnetIpv4}:${TAILNET_SIGN_IN_PORT}/`,
        expectedEnvironmentId: machine.environmentId,
        timeoutMs: DISCOVERY_PROBE_TIMEOUT_MS,
      }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed([]),
            onSome: (registration) =>
              saveTailnetRegistration(registration, false).pipe(
                // Every try signs in again and leaves a session behind on the host.
                Effect.tapError(() => Effect.sync(() => unsaveable.add(machine.environmentId))),
                Effect.as([
                  { environmentId: machine.environmentId, label: registration.target.label },
                ]),
              ),
          }),
        ),
        Effect.catch((error) =>
          Effect.logInfo("Could not add a machine found on the tailnet.", {
            environmentId: machine.environmentId,
            error,
          }).pipe(Effect.as([])),
        ),
      ),
    { concurrency: DISCOVERY_CONCURRENCY },
  );
  return {
    added: added.flat(),
    conflicts: conflicts.map(({ machine, label }) => ({ label, address: machine.tailnetIpv4 })),
  } satisfies TailnetDiscoveryResult;
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  const saved = entry === null ? null : Option.getOrNull(entry.profile);
  if (entry === null || entry.target._tag !== "BearerConnectionTarget" || !isBearerProfile(saved)) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = Option.getOrUndefined(options.credential);
  if (
    credential === undefined ||
    (!isBearerCredential(credential) && !isTailnetCredential(credential))
  ) {
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
  const target = new BearerConnectionTarget({
    environmentId: options.input.environmentId,
    label,
    connectionId,
  });
  if (isBearerCredential(credential)) {
    return new BearerConnectionRegistration({
      target,
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: options.input.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      }),
      credential,
    });
  }
  const moved = !sameAddress(httpBaseUrl, saved.httpBaseUrl);
  // A Tailscale session works only at the address it signed in at.
  if (moved && !sameAddress(httpBaseUrl, credential.signInBaseUrl)) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "A Tailscale machine's address must be its Tailscale name or 100.x address.",
    });
  }
  return new TailnetConnectionRegistration({
    target,
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      // The saved form keeps an explicit `:80`, which a bare Tailscale address would read as 3773.
      httpBaseUrl: moved ? credential.signInBaseUrl : saved.httpBaseUrl,
      wsBaseUrl: moved ? deriveWsBaseUrl(httpBaseUrl) : saved.wsBaseUrl,
      ...(moved
        ? { authorization: "tailnet" as const, network: "tailscale" as const }
        : {
            ...(saved.authorization === undefined ? {} : { authorization: saved.authorization }),
            ...(saved.network === undefined ? {} : { network: saved.network }),
          }),
    }),
    credential,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target, input.expectedEnvironmentId);
  const connectionId = `ssh:${provisioned.environmentId}:${sshTargetKey(provisioned.bootstrap.target)}`;
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
    credential: new BearerConnectionCredential({ token: provisioned.bearerToken }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  if (
    input.expectedEnvironmentId !== undefined &&
    registration.target.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(registration.target.label);
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  // Found machines that signed in but could not be saved, skipped until the app restarts.
  const unsaveable = new Set<EnvironmentId>();
  const withTailnetServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    );

  // Provisioning retains the delegated onboarding operation spans.
  return ConnectionOnboarding.of({
    registerTailnet: Effect.fnUntraced(function* (input) {
      return yield* withTailnetServices(registerTailnetConnection(input));
    }),
    addDiscoveredTailnetMachines: Effect.fnUntraced(function* (machines) {
      return yield* withTailnetServices(addDiscoveredTailnetMachines(machines, unsaveable));
    }),
    registerPairing: Effect.fnUntraced(
      function* (input) {
        return yield* registerPairingConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    registerSsh: Effect.fnUntraced(
      function* (input) {
        return yield* registerSshConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
    ),
    updateBearer: Effect.fnUntraced(
      function* (input) {
        return yield* withTailnetServices(updateBearerConnection(input));
      },
      Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
    ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
