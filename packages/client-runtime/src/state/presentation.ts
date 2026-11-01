import {
  resolveEnvironmentMachineKind,
  type EnvironmentMachineKind,
  type EnvironmentId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  RelayConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  connectionCatalogDisplayUrl,
  environmentDisplayLabel,
  presentConnectionState,
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
  type EnvironmentPresentation,
  type EnvironmentServerConfig,
} from "../connection/presentation.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { hasRelayRoute } from "../connection/routes.ts";
import type { RelayEnvironmentDiscoveryState } from "../relay/discovery.ts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

function sameConnection(
  left: EnvironmentConnectionPresentation,
  right: EnvironmentConnectionPresentation,
): boolean {
  return left.phase === right.phase && left.error === right.error && left.traceId === right.traceId;
}

function withoutProviders(
  config: ServerConfig | null,
  previous: EnvironmentServerConfig | null,
): EnvironmentServerConfig | null {
  if (config === null) {
    return null;
  }
  const { providers: _providers, ...next } = config;
  if (previous === null) {
    return next;
  }
  const keys = Object.keys(next) as Array<keyof EnvironmentServerConfig>;
  return keys.length === Object.keys(previous).length &&
    keys.every((key) => key in previous && previous[key] === next[key])
    ? previous
    : next;
}

export interface EnvironmentPresentationWithProviders extends Omit<
  EnvironmentPresentation,
  "serverConfig"
> {
  readonly serverConfig: ServerConfig | null;
}

export function createEnvironmentPresentationAtoms<E>(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, E>>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
  readonly relayDiscoveryValueAtom?: Atom.Atom<RelayEnvironmentDiscoveryState>;
}) {
  const presentationAtom = Atom.family((environmentId: EnvironmentId) => {
    let previousCatalogEntry: ConnectionCatalogEntry | undefined;
    let previousServerConfig: EnvironmentServerConfig | null = null;
    let lastConnectedLabel: string | undefined;
    let lastConnectedDiscovery: RelayClientEnvironmentRecord | undefined;
    return Atom.make((get) => {
      const entry = get(input.catalogValueAtom).entries.get(environmentId);
      if (entry === undefined) {
        lastConnectedLabel = undefined;
        lastConnectedDiscovery = undefined;
        return null;
      }
      const state = AsyncResult.getOrElse(
        get(input.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      );
      const previous = Option.getOrNull(get.self<EnvironmentPresentation | null>());
      // The supervisor never publishes this placeholder; an enabled one starts out connecting.
      const connection: EnvironmentConnectionPresentation =
        entry.unsupportedReason !== undefined
          ? { phase: "unsupported", error: entry.unsupportedReason, traceId: null }
          : state === AVAILABLE_CONNECTION_STATE && entry.enabled
            ? { phase: "connecting", error: null, traceId: null }
            : presentConnectionState(state);
      const sourceServerConfig = withoutProviders(
        get(input.serverConfigValueAtom(environmentId)),
        previousServerConfig,
      );
      let serverConfig = sourceServerConfig;
      let displayEntry = entry;
      if (entry.target._tag === "RelayConnectionTarget" && input.relayDiscoveryValueAtom) {
        const discovered = get(input.relayDiscoveryValueAtom).environments.get(
          environmentId,
        )?.environment;
        if (connection.phase === "connected" && sourceServerConfig !== null) {
          lastConnectedLabel = sourceServerConfig.environment.label;
          lastConnectedDiscovery = discovered;
        }
        // An unchanged relay snapshot cannot replace a newer name received over the live socket.
        const label =
          connection.phase === "connected"
            ? undefined
            : lastConnectedLabel !== undefined &&
                (discovered === undefined || discovered === lastConnectedDiscovery)
              ? lastConnectedLabel
              : discovered?.label;
        if (label !== undefined) {
          if (label !== entry.target.label) {
            // Discovery can refresh a name without rebuilding saved routes or restarting their supervisor.
            displayEntry =
              previousCatalogEntry === entry && previous?.entry.target.label === label
                ? previous.entry
                : { ...entry, target: new RelayConnectionTarget({ environmentId, label }) };
          }
          if (sourceServerConfig !== null && sourceServerConfig.environment.label !== label) {
            serverConfig =
              sourceServerConfig === previousServerConfig &&
              previous?.serverConfig?.environment.label === label
                ? previous.serverConfig
                : {
                    ...sourceServerConfig,
                    environment: { ...sourceServerConfig.environment, label },
                  };
          }
        }
      } else {
        lastConnectedLabel = undefined;
        lastConnectedDiscovery = undefined;
      }
      previousCatalogEntry = entry;
      previousServerConfig = sourceServerConfig;
      const next = {
        entry: displayEntry,
        connection:
          previous !== null && sameConnection(previous.connection, connection)
            ? previous.connection
            : connection,
        serverConfig,
      } satisfies EnvironmentPresentation;
      return previous !== null &&
        previous.entry === next.entry &&
        previous.connection === next.connection &&
        previous.serverConfig === next.serverConfig
        ? previous
        : next;
    }).pipe(Atom.withLabel(`environment-presentation:${environmentId}`));
  });

  let previous: ReadonlyMap<EnvironmentId, EnvironmentPresentation> = new Map();
  const presentationsAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, EnvironmentPresentation>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const presentation = get(presentationAtom(environmentId));
      if (presentation !== null) {
        next.set(environmentId, presentation);
      }
    }
    if (mapsEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-presentations"));

  // Enabled environments only, like the full server-configs map, but without providers, so
  // capability checks on every sidebar row and markdown link skip provider status pushes.
  const serverConfigsAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, EnvironmentServerConfig>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const serverConfig = get(presentationAtom(environmentId))?.serverConfig;
      if (serverConfig != null) {
        next.set(environmentId, serverConfig);
      }
    }
    const previous = Option.getOrNull(
      get.self<ReadonlyMap<EnvironmentId, EnvironmentServerConfig>>(),
    );
    return previous !== null && mapsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("environment-server-configs-without-providers"));

  const providersByEnvironmentAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, ReadonlyArray<ServerProvider>>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const providers = get(input.serverConfigValueAtom(environmentId))?.providers;
      if (providers !== undefined) {
        next.set(environmentId, providers);
      }
    }
    const previous = Option.getOrNull(
      get.self<ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>>(),
    );
    return previous !== null && mapsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("environment-providers"));

  // Enabled environments only, like serverConfigsAtom: a disabled connection keeps its cached
  // config, and its accounts would otherwise count in usage limits. Usage limits ride on provider
  // statuses, so these surfaces rebuild on every push by design.
  const presentationsWithProvidersAtom = Atom.make((get) => {
    const previous = Option.getOrNull(
      get.self<ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>>(),
    );
    const next = new Map<EnvironmentId, EnvironmentPresentationWithProviders>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const presentation = get(presentationAtom(environmentId));
      if (presentation === null) continue;
      const rawConfig = get(input.serverConfigValueAtom(environmentId));
      const prior = previous?.get(environmentId);
      const projectedConfig = presentation.serverConfig;
      const serverConfig =
        rawConfig === null || projectedConfig === null
          ? null
          : rawConfig.environment === projectedConfig.environment
            ? rawConfig
            : prior?.serverConfig != null &&
                prior.serverConfig.providers === rawConfig.providers &&
                withoutProviders(prior.serverConfig, projectedConfig) === projectedConfig
              ? prior.serverConfig
              : { ...projectedConfig, providers: rawConfig.providers };
      next.set(
        environmentId,
        prior !== undefined &&
          prior.entry === presentation.entry &&
          prior.connection === presentation.connection &&
          prior.serverConfig === serverConfig
          ? prior
          : { ...presentation, serverConfig },
      );
    }
    return previous !== null && mapsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("environment-presentations-with-providers"));

  return {
    presentationAtom,
    presentationsAtom,
    serverConfigsAtom,
    providersByEnvironmentAtom,
    presentationsWithProvidersAtom,
  };
}

export interface EnvironmentConnectionSummary {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly isRelayManaged: boolean;
  readonly isEnabled: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly connectionErrorTraceId: string | null;
}

export function projectEnvironmentConnectionSummary(
  environmentId: EnvironmentId,
  environment: EnvironmentPresentation,
): EnvironmentConnectionSummary {
  return {
    environmentId,
    environmentLabel: environmentDisplayLabel(environment.entry, environment.serverConfig),
    displayUrl: connectionCatalogDisplayUrl(environment.entry) ?? "",
    isRelayManaged: hasRelayRoute(environment.entry),
    isEnabled: environment.entry.enabled,
    connectionState: environment.connection.phase,
    connectionError: environment.connection.error,
    connectionErrorTraceId: environment.connection.traceId,
  };
}

export function createEnvironmentSummaryAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
}) {
  const environmentIdsAtom = Atom.make((get) => {
    const next = [...get(input.catalogValueAtom).entries.keys()];
    const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
    return previous !== null &&
      previous.length === next.length &&
      next.every((id, index) => id === previous[index])
      ? previous
      : next;
  });
  const identitiesAtom = Atom.make((get) => {
    const next = [...get(input.catalogValueAtom).entries].map(([environmentId, entry]) => {
      const presentation = get(input.presentationAtom(environmentId));
      return {
        environmentId,
        label: environmentDisplayLabel(
          presentation?.entry ?? entry,
          presentation?.serverConfig ?? null,
        ),
      };
    });
    const previous = Option.getOrNull(
      get.self<ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>>(),
    );
    return previous !== null &&
      previous.length === next.length &&
      next.every(
        (value, index) =>
          value.environmentId === previous[index]?.environmentId &&
          value.label === previous[index]?.label,
      )
      ? previous
      : next;
  });
  const environmentAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const presentation = get(input.presentationAtom(environmentId));
      if (presentation === null) return null;
      const next = projectEnvironmentConnectionSummary(environmentId, presentation);
      const previous = Option.getOrNull(get.self<EnvironmentConnectionSummary | null>());
      if (
        previous !== null &&
        previous.environmentId === next.environmentId &&
        previous.environmentLabel === next.environmentLabel &&
        previous.displayUrl === next.displayUrl &&
        previous.isRelayManaged === next.isRelayManaged &&
        previous.isEnabled === next.isEnabled &&
        previous.connectionState === next.connectionState &&
        previous.connectionError === next.connectionError &&
        previous.connectionErrorTraceId === next.connectionErrorTraceId
      )
        return previous;
      return next;
    }),
  );
  const environmentsAtom = Atom.make((get) => {
    const next: Array<EnvironmentConnectionSummary> = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const environment = get(environmentAtom(environmentId));
      if (environment !== null) next.push(environment);
    }
    const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentConnectionSummary>>());
    return previous !== null &&
      previous.length === next.length &&
      next.every((value, index) => value === previous[index])
      ? previous
      : next;
  }).pipe(Atom.withLabel("environment-connection-summaries"));
  const connectedEnvironmentIdsAtom = Atom.make((get) => {
    const next = get(environmentIdsAtom).filter(
      (id) => get(environmentAtom(id))?.connectionState === "connected",
    );
    const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
    return previous !== null &&
      previous.length === next.length &&
      next.every((id, index) => id === previous[index])
      ? previous
      : next;
  });
  const machineByIdAtom = Atom.make((get) => {
    const next = new Map(
      get(environmentIdsAtom).map(
        (environmentId) =>
          [
            environmentId,
            resolveEnvironmentMachineKind(
              get(input.presentationAtom(environmentId))?.serverConfig ?? null,
            ),
          ] as const,
      ),
    );
    const previous = Option.getOrNull(
      get.self<ReadonlyMap<EnvironmentId, EnvironmentMachineKind>>(),
    );
    return previous !== null && mapsEqual(previous, next) ? previous : next;
  });
  const pullRequestsSupportedAtom = Atom.make((get) =>
    get(environmentIdsAtom).some(
      (environmentId) =>
        (get(input.presentationAtom(environmentId))?.serverConfig ?? null) !== null,
    ),
  );
  return {
    environmentIdsAtom,
    connectedEnvironmentIdsAtom,
    identitiesAtom,
    environmentsAtom,
    machineByIdAtom,
    pullRequestsSupportedAtom,
  };
}
