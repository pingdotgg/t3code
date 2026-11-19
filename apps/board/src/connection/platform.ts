import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  CredentialStore,
  makePullRequestRoutingPermissions,
  mapRemoteEnvironmentError,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  ProfileStore,
  PullRequestRoutingPermissions,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import {
  deriveWsBaseUrl,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime/environment";
import {
  ClientCapabilities,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  type ConnectionCatalogDocument,
  Persistence,
  PlatformConnectionSource,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
} from "@t3tools/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import { engineBridge } from "./bridge";
import type { EngineState } from "./engineState";

const layerConnectivity = Connectivity.layer({
  status: Effect.sync(() => (navigator.onLine ? "online" : "offline")),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const layerWakeups = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible")
            Queue.offerUnsafe(queue, "application-active");
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) => Effect.sync(() => document.removeEventListener("visibilitychange", listener)),
    ).pipe(Effect.asVoid),
  ),
});

// The catalog is rebuilt from the engine on every launch, so nothing here outlives the process.
const layerPersistence = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* Ref.make<ConnectionCatalogDocument>(EMPTY_CONNECTION_CATALOG_DOCUMENT);
    const update = (
      transform: (document: ConnectionCatalogDocument) => ConnectionCatalogDocument,
    ) => Ref.update(catalog, transform);
    const read = Ref.get(catalog);

    const targetStore = Persistence.ConnectionTargetStore.of({
      list: Effect.map(read, (document) => document.targets),
      listDisabled: Effect.map(read, (document) => document.disabledEnvironmentIds),
    });
    const registrationStore = Persistence.ConnectionRegistrationStore.of({
      register: (registration, routes) =>
        update((document) => registerConnectionInCatalog(document, registration, routes)),
      setRoutes: (environmentId, routes) =>
        update((document) => setRoutesInCatalog(document, environmentId, routes)),
      remove: (environmentId) =>
        update((document) => removeConnectionFromCatalog(document, environmentId)),
      setEnabled: (environmentId, enabled) =>
        update((document) => setConnectionEnabledInCatalog(document, environmentId, enabled)),
    });
    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        Effect.map(read, (document) =>
          Option.fromUndefinedOr(
            document.profiles.find((candidate) => candidate.connectionId === connectionId),
          ),
        ),
      put: (profile) =>
        update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        Effect.map(read, (document) =>
          Option.fromUndefinedOr(
            document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
          ),
        ),
      put: (connectionId, credential) =>
        update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });
    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        Effect.map(read, (document) =>
          Option.fromUndefinedOr(
            document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
          ),
        ),
      put: (token) => update((document) => putRemoteDpopTokenInCatalog(document, token)),
      remove: (environmentId) =>
        update((document) => ({
          ...document,
          remoteDpopTokens: removeCatalogValue(
            document.remoteDpopTokens,
            (value) => value.environmentId,
            environmentId,
          ),
        })),
    });
    const routingPermissions = yield* makePullRequestRoutingPermissions({
      read: Effect.map(read, (document) => document.githubRoutingPermissions ?? []),
      write: (githubRoutingPermissions) =>
        update((document) => ({ ...document, githubRoutingPermissions })),
    });
    // The board keeps no offline copy: it reads the live shell every launch.
    const cacheStore = Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeedNone,
      saveShell: () => Effect.void,
      loadThread: () => Effect.succeedNone,
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    });
    return Context.make(Persistence.ConnectionTargetStore, targetStore).pipe(
      Context.add(PullRequestRoutingPermissions, routingPermissions),
      Context.add(Persistence.ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(Persistence.EnvironmentCacheStore, cacheStore),
    );
  }),
);

const sshUnsupported = () =>
  Effect.fail(
    new ConnectionBlockedError({
      reason: "unsupported",
      detail: "SSH environments are not available in Agent Board.",
    }),
  );

// The engine is a bearer-authenticated "primary": its token comes from the main process, which
// checks it on every read and reissues it once when the engine rejected it.
const primaryAuth = ClientCapabilities.PrimaryEnvironmentAuth.of({
  bearerToken: Effect.tryPromise({
    try: () => engineBridge.engineToken(),
    catch: (cause) =>
      new ConnectionTransientError({ reason: "remote-unavailable", detail: String(cause) }),
  }).pipe(
    Effect.flatMap((result) => {
      if (result.ok) return Effect.succeedSome(result.token);
      return Effect.fail(
        result.error === "auth_failed"
          ? new ConnectionBlockedError({ reason: "authentication", detail: "auth_failed" })
          : new ConnectionTransientError({ reason: "remote-unavailable", detail: result.detail }),
      );
    }),
  ),
});

const layerCapabilities = Layer.succeedContext(
  Context.make(ClientCapabilities.PrimaryEnvironmentAuth, primaryAuth).pipe(
    Context.add(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        identity: Effect.succeedNone,
        clerkToken: Effect.fail(
          new ConnectionBlockedError({
            reason: "authentication",
            detail: "T3 Connect is not available in Agent Board.",
          }),
        ),
      }),
    ),
    Context.add(
      ClientCapabilities.RelayDeviceIdentity,
      ClientCapabilities.RelayDeviceIdentity.of({ deviceId: Effect.succeedNone }),
    ),
    Context.add(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: { label: "Agent Board", surface: "desktop" },
      }),
    ),
    Context.add(
      ClientCapabilities.SshEnvironmentGateway,
      ClientCapabilities.SshEnvironmentGateway.of({
        provision: sshUnsupported,
        prepare: sshUnsupported,
        disconnect: () => Effect.void,
      }),
    ),
  ),
);

const engineStates = Stream.callback<EngineState>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const unsubscribe = engineBridge.onEngineState((state) => Queue.offerUnsafe(queue, state));
      void engineBridge.engineState().then((state) => Queue.offerUnsafe(queue, state));
      return unsubscribe;
    }),
    (unsubscribe) => Effect.sync(unsubscribe),
  ).pipe(Effect.asVoid),
);

const loadRegistration = (httpBaseUrl: string) =>
  fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
    Effect.map(
      (descriptor) =>
        new PrimaryConnectionRegistration({
          target: new PrimaryConnectionTarget({
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            httpBaseUrl,
            wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
          }),
        }),
    ),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
    Effect.provide(FetchHttpClient.layer),
  );

const isReady = (state: EngineState): state is Extract<EngineState, { phase: "ready" }> =>
  state.phase === "ready";

const layerPlatformConnectionSource = Layer.succeed(
  PlatformConnectionSource.PlatformConnectionSource,
  PlatformConnectionSource.PlatformConnectionSource.of({
    registrations: engineStates.pipe(
      Stream.filter(isReady),
      Stream.map((state) => state.origin),
      Stream.changes,
      Stream.mapEffect((origin) =>
        loadRegistration(origin).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not describe the engine.", { error }),
          ),
          Effect.option,
        ),
      ),
      Stream.flatMap((registration) =>
        Option.isSome(registration) ? Stream.make([registration.value]) : Stream.empty,
      ),
    ),
  }),
);

export const layer = Layer.mergeAll(
  layerPersistence,
  layerConnectivity,
  layerWakeups,
  layerCapabilities,
  layerPlatformConnectionSource,
);
