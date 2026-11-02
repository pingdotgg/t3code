import {
  DEFAULT_SERVER_SETTINGS,
  type EditorId,
  type EnvironmentId,
  type EnvironmentTheme,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleLegacyThreadMigrationPayload,
  type ServerLifecycleWelcomePayload,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  presentConnectionState,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createOutdatedServerUpdateCommand } from "@t3tools/client-runtime/state/outdatedServerUpdate";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import { mergeWithDefaultKeybindings } from "@t3tools/shared/keybindings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { isConnectedWithConfig } from "../components/settings/scopedSettings";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList } from "./environmentAtomList";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";
import { reuseProvidersIgnoringCheckedAt } from "./serverProviders.logic";

// Subscribe to every environment's themes; primary can change without reconnecting or updating the subscription.
export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  environmentThemes: true,
  usageLimitSources: true,
  usageLimitsCommand: true,
});
export const environmentUpdateStatesAtom = environmentAtomList(
  "web-environment-update-states",
  serverEnvironment.updateStateAtom,
);
export const updateOutdatedServer = createOutdatedServerUpdateCommand(connectionAtomRuntime);
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

interface PrimaryServerState {
  readonly config: ServerConfig | null;
  readonly latestEvent: ServerConfigStreamEvent | null;
  readonly welcome: ServerLifecycleWelcomePayload | null;
}

const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];
export const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const EMPTY_PRIMARY_SERVER_STATE: PrimaryServerState = {
  config: null,
  latestEvent: null,
  welcome: null,
};

const primaryServerStateAtom = Atom.make((get): PrimaryServerState => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return EMPTY_PRIMARY_SERVER_STATE;
  }

  const target = { environmentId, input: {} };
  const configProjection = AsyncResult.getOrElse(
    get(serverEnvironment.configProjection(target)),
    () => null,
  );
  const welcome = AsyncResult.getOrElse(get(serverEnvironment.welcome(target)), () => null);

  return {
    config: get(serverEnvironment.configValueAtom(environmentId)),
    latestEvent: configProjection?.latestEvent ?? null,
    welcome,
  };
}).pipe(Atom.withLabel("web-primary-server-state"));

export const primaryServerConfigAtom = Atom.make(
  (get): ServerConfig | null => get(primaryServerStateAtom).config,
).pipe(Atom.withLabel("web-primary-server-config"));

export const primaryServerConfigEventAtom = Atom.make(
  (get): ServerConfigStreamEvent | null => get(primaryServerStateAtom).latestEvent,
).pipe(Atom.withLabel("web-primary-server-config-event"));

export const primaryServerWelcomeAtom = Atom.make(
  (get): ServerLifecycleWelcomePayload | null => get(primaryServerStateAtom).welcome,
).pipe(Atom.withLabel("web-primary-server-welcome"));

export const primaryServerLegacyThreadMigrationAtom = Atom.make(
  (get): ServerLifecycleLegacyThreadMigrationPayload | null => {
    const environmentId = get(primaryEnvironmentIdAtom);
    if (environmentId === null) {
      return null;
    }
    return AsyncResult.getOrElse(
      get(serverEnvironment.legacyThreadMigration({ environmentId, input: {} })),
      () => null,
    );
  },
).pipe(Atom.withLabel("web-primary-server-legacy-thread-migration"));

export const primaryServerSettingsAtom = Atom.make(
  (get): ServerSettings => get(primaryServerConfigAtom)?.settings ?? DEFAULT_SERVER_SETTINGS,
).pipe(Atom.withLabel("web-primary-server-settings"));

export const primaryServerProvidersAtom = Atom.make(
  (get): ReadonlyArray<ServerProvider> =>
    get(primaryServerConfigAtom)?.providers ?? EMPTY_SERVER_PROVIDERS,
).pipe(Atom.withLabel("web-primary-server-providers"));

/** Without a primary, global shortcuts follow unscoped Settings. */
export function createShortcutKeybindingsAtom(input: {
  readonly primaryEnvironmentIdAtom: Atom.Atom<EnvironmentId | null>;
  readonly primaryConfigAtom: Atom.Atom<ServerConfig | null>;
  readonly environmentsAtom: Atom.Atom<
    ReadonlyMap<EnvironmentId, Pick<EnvironmentPresentation, "connection" | "serverConfig">>
  >;
}) {
  // Selected before merging, so unrelated config updates keep the merged array.
  const customAtom = Atom.make((get) => {
    if (get(input.primaryEnvironmentIdAtom) !== null) {
      // A primary stays authoritative while its config loads.
      return get(input.primaryConfigAtom)?.keybindings ?? null;
    }
    const environments = [...get(input.environmentsAtom).values()];
    return environments.find(isConnectedWithConfig)?.serverConfig?.keybindings ?? null;
  });
  return Atom.make((get): ServerConfig["keybindings"] =>
    mergeWithDefaultKeybindings(get(customAtom) ?? []),
  );
}

// Settings' presentations import this module; mirror their catalog order and
// connection presentation here to avoid a cycle.
const environmentConnectionsAtom = Atom.make((get) => {
  const environments = new Map<
    EnvironmentId,
    Pick<EnvironmentPresentation, "connection" | "serverConfig">
  >();
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    const state = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    environments.set(environmentId, {
      connection:
        entry.unsupportedReason === undefined
          ? presentConnectionState(state)
          : { phase: "unsupported", error: entry.unsupportedReason, traceId: null },
      serverConfig: get(serverEnvironment.configValueAtom(environmentId)),
    });
  }
  return environments;
});

export const primaryServerKeybindingsAtom = createShortcutKeybindingsAtom({
  primaryEnvironmentIdAtom,
  primaryConfigAtom: primaryServerConfigAtom,
  environmentsAtom: environmentConnectionsAtom,
}).pipe(Atom.withLabel("web-primary-server-keybindings"));

export const primaryServerAvailableEditorsAtom = Atom.make(
  (get): ReadonlyArray<EditorId> =>
    get(primaryServerConfigAtom)?.availableEditors ?? EMPTY_AVAILABLE_EDITORS,
).pipe(Atom.withLabel("web-primary-server-available-editors"));

const EMPTY_ENVIRONMENT_THEMES: ReadonlyArray<EnvironmentTheme> = [];

export const primaryServerEnvironmentThemesAtom = Atom.make(
  (get): ReadonlyArray<EnvironmentTheme> =>
    get(primaryServerConfigAtom)?.environmentThemes ?? EMPTY_ENVIRONMENT_THEMES,
).pipe(Atom.withLabel("web-primary-server-environment-themes"));

export const providersIgnoringCheckedAtAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ServerProvider> =>
    reuseProvidersIgnoringCheckedAt(
      Option.getOrNull(get.self<ReadonlyArray<ServerProvider>>()),
      get(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS,
    ),
  ).pipe(Atom.withLabel(`web-providers-ignoring-checked-at:${environmentId}`)),
);
