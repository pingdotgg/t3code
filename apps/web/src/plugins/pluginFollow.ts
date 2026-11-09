import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";

/** Choices the user made in Settings; an environment left out keeps its default. */
type PluginUiChoices = ReadonlyMap<EnvironmentId, boolean>;

const CHOICES_KEY = "t3.plugins.uiEnvironments";
const isEnvironmentId = Schema.is(EnvironmentId);

// Reading localStorage throws where the browser blocks storage; only the main environment loads,
// once the app is idle.
const pluginStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const readChoices = (): PluginUiChoices => {
  try {
    const stored: unknown = JSON.parse(pluginStorage()?.getItem(CHOICES_KEY) ?? "{}");
    if (typeof stored !== "object" || stored === null) return new Map();
    return new Map(
      Object.entries(stored).flatMap(([environmentId, on]) =>
        isEnvironmentId(environmentId) && typeof on === "boolean" ? [[environmentId, on]] : [],
      ),
    );
  } catch {
    return new Map();
  }
};

/**
 * Which environments this browser loads plugin UI from, kept in this browser alone because their
 * plugin code runs in this window with every connection's credentials.
 */
export const pluginUiChoicesAtom = Atom.writable(readChoices, (ctx, choices: PluginUiChoices) => {
  try {
    if (choices.size === 0) pluginStorage()?.removeItem(CHOICES_KEY);
    else pluginStorage()?.setItem(CHOICES_KEY, JSON.stringify(Object.fromEntries(choices)));
  } catch {
    // A full or blocked storage keeps the choice for this page only.
  }
  ctx.setSelf(choices);
}).pipe(Atom.keepAlive, Atom.withLabel("web-plugin-ui-choices"));

const DREW_KEY = "t3.plugins.drewEnvironments";

const readDrew = (): ReadonlyArray<string> => {
  try {
    const stored: unknown = JSON.parse(pluginStorage()?.getItem(DREW_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
};

// Plugins that drew here last time start with the app instead of once it is idle, so the layout
// they change settles sooner.
export const drewPluginsLastTime = (environmentId: EnvironmentId) =>
  readDrew().includes(environmentId);

export function rememberDrawsPlugins(environmentId: EnvironmentId, draws: boolean) {
  const drew = readDrew();
  if (drew.includes(environmentId) === draws) return;
  const next = draws ? [...drew, environmentId] : drew.filter((id) => id !== environmentId);
  try {
    if (next.length === 0) pluginStorage()?.removeItem(DREW_KEY);
    else pluginStorage()?.setItem(DREW_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage leaves plugin UI to start once the app is idle.
  }
}

export const loadsPluginUi = (
  choices: PluginUiChoices,
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
) => choices.get(environmentId) ?? environmentId === primaryEnvironmentId;

/** A choice equal to the default is dropped. */
export function withPluginUiChoice(
  choices: PluginUiChoices,
  environmentId: EnvironmentId,
  on: boolean,
  primaryEnvironmentId: EnvironmentId | null,
): PluginUiChoices {
  const next = new Map(choices);
  next.delete(environmentId);
  if (on !== (environmentId === primaryEnvironmentId)) next.set(environmentId, on);
  return next;
}

/** The main environment first, then the others in the order chosen. */
export const chosenPluginUiEnvironments = (
  choices: PluginUiChoices,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<EnvironmentId> => [
  ...(primaryEnvironmentId !== null &&
  loadsPluginUi(choices, primaryEnvironmentId, primaryEnvironmentId)
    ? [primaryEnvironmentId]
    : []),
  ...[...choices].flatMap(([environmentId, on]) =>
    on && environmentId !== primaryEnvironmentId ? [environmentId] : [],
  ),
];

export const pluginUiEnvironmentsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const next = chosenPluginUiEnvironments(
    get(pluginUiChoicesAtom),
    get(primaryEnvironmentIdAtom),
  ).filter(
    (environmentId) =>
      get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities.plugins ===
      true,
  );
  // Config pushes recompute this; the same list keeps every loader running.
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null &&
    previous.length === next.length &&
    previous.every((environmentId, index) => environmentId === next[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("web-plugin-ui-environments"));
