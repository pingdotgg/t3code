import {
  DEFAULT_SERVER_SETTINGS,
  type EditorId,
  type EnvironmentTheme,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";

// Opted in for every environment, not just the primary one. Only the primary
// environment's themes are rendered, but which environment is primary changes
// at runtime and the subscription payload is fixed when it is established --
// gating on "primary right now" would leave a newly promoted environment with
// no themes until it reconnected. The set is capped server-side and stripped
// before caching, so following all of them costs a few KB per environment.
export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  environmentThemes: true,
});
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
const DEFAULT_BOARD_OPEN_KEYBINDING = DEFAULT_RESOLVED_KEYBINDINGS.find(
  (keybinding) => keybinding.command === "board.open",
);
const EMPTY_PRIMARY_SERVER_STATE: PrimaryServerState = {
  config: null,
  latestEvent: null,
  welcome: null,
};

export const primaryServerStateAtom = Atom.make((get): PrimaryServerState => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return EMPTY_PRIMARY_SERVER_STATE;
  }

  const target = { environmentId, input: {} };
  const configProjection = Option.getOrNull(
    AsyncResult.value(get(serverEnvironment.configProjection(target))),
  );
  const welcome = Option.getOrNull(AsyncResult.value(get(serverEnvironment.welcome(target))));

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

export const primaryServerSettingsAtom = Atom.make(
  (get): ServerSettings => get(primaryServerConfigAtom)?.settings ?? DEFAULT_SERVER_SETTINGS,
).pipe(Atom.withLabel("web-primary-server-settings"));

export const primaryServerProvidersAtom = Atom.make(
  (get): ReadonlyArray<ServerProvider> =>
    get(primaryServerConfigAtom)?.providers ?? EMPTY_SERVER_PROVIDERS,
).pipe(Atom.withLabel("web-primary-server-providers"));

/**
 * Older servers omit `board.open` because their keybinding schema cannot
 * persist it. The client still owns dispatch for Board, so retain its default
 * shortcut locally while the server's bindings catch up.
 */
export function resolvePrimaryServerKeybindings(
  keybindings: ServerConfig["keybindings"] | null,
  supportsBoardKeybinding: boolean,
): ServerConfig["keybindings"] {
  const resolved = keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  if (
    supportsBoardKeybinding ||
    resolved.some((keybinding) => keybinding.command === "board.open")
  ) {
    return resolved;
  }
  return DEFAULT_BOARD_OPEN_KEYBINDING ? [DEFAULT_BOARD_OPEN_KEYBINDING, ...resolved] : resolved;
}

export const primaryServerKeybindingsAtom = Atom.make((get): ServerConfig["keybindings"] => {
  const config = get(primaryServerConfigAtom);
  return resolvePrimaryServerKeybindings(
    config?.keybindings ?? null,
    config?.environment.capabilities.boardKeybinding === true,
  );
}).pipe(Atom.withLabel("web-primary-server-keybindings"));

export const primaryServerSupportsBoardKeybindingAtom = Atom.make(
  (get): boolean => get(primaryServerConfigAtom)?.environment.capabilities.boardKeybinding === true,
).pipe(Atom.withLabel("web-primary-server-supports-board-keybinding"));

export const primaryServerAvailableEditorsAtom = Atom.make(
  (get): ReadonlyArray<EditorId> =>
    get(primaryServerConfigAtom)?.availableEditors ?? EMPTY_AVAILABLE_EDITORS,
).pipe(Atom.withLabel("web-primary-server-available-editors"));

export const primaryServerKeybindingsConfigPathAtom = Atom.make(
  (get): string | null => get(primaryServerConfigAtom)?.keybindingsConfigPath ?? null,
).pipe(Atom.withLabel("web-primary-server-keybindings-config-path"));

const EMPTY_ENVIRONMENT_THEMES: ReadonlyArray<EnvironmentTheme> = [];

/**
 * Palettes published by the primary environment's machine. Only the primary
 * environment: a client follows the machine it is anchored to, not every
 * environment it happens to be connected to.
 */
export const primaryServerEnvironmentThemesAtom = Atom.make(
  (get): ReadonlyArray<EnvironmentTheme> =>
    get(primaryServerConfigAtom)?.environmentThemes ?? EMPTY_ENVIRONMENT_THEMES,
).pipe(Atom.withLabel("web-primary-server-environment-themes"));

export const primaryServerObservabilityAtom = Atom.make(
  (get): ServerConfig["observability"] | null =>
    get(primaryServerConfigAtom)?.observability ?? null,
).pipe(Atom.withLabel("web-primary-server-observability"));
