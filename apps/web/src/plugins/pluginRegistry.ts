import type { EnvironmentId, PLUGIN_COMMAND_PATTERN } from "@t3tools/contracts";
import type { WebPluginParts } from "@t3tools/plugin-sdk/web";
import { Atom } from "effect/reactivity";
import type { ComponentType } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";

export interface PluginRightPanelEntry {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly name: string;
  readonly title: string;
  readonly component: ComponentType<{ readonly threadId: string }>;
  readonly owner: PluginOwner;
}

export interface PluginCommandEntry {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly command: typeof PLUGIN_COMMAND_PATTERN.Type;
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
  readonly run: () => void;
}

// Plain maps with one list-level version: readers re-render on the version alone, so a plugin never
// adds a subscription per panel or command. App code outside the plugin runtime and lazy routes
// reads them through `pluginUi.ts`, so this stays out of startup.
const rightPanels = new Map<string, PluginRightPanelEntry>();
const settingsPanels = new Map<string, PluginSettingsPanelEntry>();
const webFailures = new Map<string, string>();
const webLoaded = new Set<string>();
const commands = new Map<string, PluginCommandEntry>();

// Reads go through atoms derived from the version, so React Compiler cannot cache a stale lookup.
const versionAtom = Atom.make(0).pipe(Atom.keepAlive);

const bump = () => appAtomRegistry.set(versionAtom, appAtomRegistry.get(versionAtom) + 1);

// Keeps the previous list while its entries match, so a change elsewhere re-renders no reader.
const stableList = <Entry>() => {
  let previous: ReadonlyArray<Entry> = [];
  return (next: ReadonlyArray<Entry>) => {
    if (next.length === previous.length && next.every((entry, i) => entry === previous[i])) {
      return previous;
    }
    previous = next;
    return next;
  };
};

export const pluginContributionKey = (environmentId: EnvironmentId, pluginId: string) =>
  `${environmentId}\u0000${pluginId}`;
export const pluginRightPanelKey = (environmentId: EnvironmentId, pluginId: string, name: string) =>
  `${pluginContributionKey(environmentId, pluginId)}\u0000${name}`;

export function registerPluginRightPanel(entry: PluginRightPanelEntry): () => void {
  const key = pluginRightPanelKey(entry.environmentId, entry.pluginId, entry.name);
  if (rightPanels.has(key)) {
    throw new Error(`Right panel "${entry.name}" is already registered.`);
  }
  rightPanels.set(key, entry);
  bump();
  return () => {
    if (rightPanels.get(key) !== entry) return;
    rightPanels.delete(key);
    bump();
  };
}

export const pluginRightPanelAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return rightPanels.get(key);
  }),
);

export const pluginRightPanelsAtom = Atom.family((environmentId: string) => {
  const stable = stableList<PluginRightPanelEntry>();
  return Atom.make((get) => {
    get(versionAtom);
    return stable(
      [...rightPanels.values()].filter((entry) => entry.environmentId === environmentId),
    );
  });
});

export interface PluginSettingsPanelEntry {
  readonly component: ComponentType;
  readonly owner: PluginOwner;
}

/** Replaces the plugin's generated settings form. */
export function registerPluginSettingsPanel(entry: PluginSettingsPanelEntry): () => void {
  const key = pluginContributionKey(entry.owner.environmentId, entry.owner.pluginId);
  settingsPanels.set(key, entry);
  bump();
  return () => {
    if (settingsPanels.get(key) !== entry) return;
    settingsPanels.delete(key);
    bump();
  };
}

export const pluginSettingsPanelAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return settingsPanels.get(key);
  }),
);

export function setPluginWebFailure(
  environmentId: EnvironmentId,
  pluginId: string,
  message: string | undefined,
) {
  const key = pluginContributionKey(environmentId, pluginId);
  if (webFailures.get(key) === message) return;
  if (message === undefined) webFailures.delete(key);
  else webFailures.set(key, message);
  bump();
}

export const pluginWebFailuresAtom = Atom.family((pluginId: string) =>
  Atom.make((get): ReadonlyMap<string, string> => {
    get(versionAtom);
    const suffix = `\u0000${pluginId}`;
    return new Map(
      [...webFailures].flatMap(([key, message]) =>
        key.endsWith(suffix) ? [[key.slice(0, -suffix.length), message] as const] : [],
      ),
    );
  }),
);

export function markPluginWebLoaded(environmentId: EnvironmentId, pluginId: string): () => void {
  const key = pluginContributionKey(environmentId, pluginId);
  webLoaded.add(key);
  bump();
  return () => {
    if (webLoaded.delete(key)) bump();
  };
}

/** Keyed by `pluginContributionKey`. */
export const pluginWebLoadedAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get(versionAtom);
    return webLoaded.has(key);
  }),
);

export function registerPluginCommand(entry: PluginCommandEntry): () => void {
  const key = `${entry.environmentId}\u0000${entry.command}`;
  if (commands.has(key)) {
    throw new Error(`Command "${entry.command}" is already registered.`);
  }
  commands.set(key, entry);
  bump();
  return () => {
    if (commands.get(key) !== entry) return;
    commands.delete(key);
    bump();
  };
}

export function pluginCommandLabel(command: string): string | undefined {
  for (const entry of commands.values()) {
    if (entry.command === command) return `${entry.pluginName}: ${entry.title}`;
  }
  return undefined;
}

const stableCommands = stableList<PluginCommandEntry>();

export const pluginCommandsAtom = Atom.make((get) => {
  get(versionAtom);
  return stableCommands([...commands.values()]);
});

export type PluginPartName = keyof WebPluginParts;

/** A replaceable part's pieces. `original` is T3's own drawing, also drawn when the plugin's throws. */
export type PluginPartProps<Part extends PluginPartName> = WebPluginParts[Part];

export interface PluginReplacementEntry<Part extends PluginPartName> {
  readonly component: ComponentType<PluginPartProps<Part>>;
  readonly owner: PluginOwner;
}

// Each part keeps every replacement, so unloading the newest brings back the one before it.
const replacements: { [Part in PluginPartName]: Array<PluginReplacementEntry<Part>> } = {
  "composer.controls": [],
  "app.pageFrame": [],
  "app.sidebar": [],
};

// Its own version: replaceable parts sit on hot paths, so other plugin changes must not
// re-render them.
const replacementsVersionAtom = Atom.make(0).pipe(Atom.keepAlive);

// The plugin whose id sorts first wins, so parallel loading can't change which one draws a part;
// within one plugin its newest replacement wins.
const winningEntry = <Entry extends { readonly owner: PluginOwner }>(
  entries: ReadonlyArray<Entry>,
) =>
  entries.reduce<Entry | undefined>(
    (winner, entry) =>
      winner === undefined || entry.owner.pluginId <= winner.owner.pluginId ? entry : winner,
    undefined,
  );

const replacementAtom = <Part extends PluginPartName>(part: Part) =>
  Atom.make((get) => {
    get(replacementsVersionAtom);
    return winningEntry(replacements[part]);
  });

export const pluginReplacementAtoms: {
  readonly [Part in PluginPartName]: Atom.Atom<PluginReplacementEntry<Part> | undefined>;
} = {
  "composer.controls": replacementAtom("composer.controls"),
  "app.pageFrame": replacementAtom("app.pageFrame"),
  "app.sidebar": replacementAtom("app.sidebar"),
};

/** Whether a plugin draws each part, which app code reads before building the part's pieces. */
export const pluginPartReplacedAtoms: { readonly [Part in PluginPartName]: Atom.Atom<boolean> } = {
  "composer.controls": Atom.make(
    (get) => get(pluginReplacementAtoms["composer.controls"]) !== undefined,
  ),
  "app.pageFrame": Atom.make((get) => get(pluginReplacementAtoms["app.pageFrame"]) !== undefined),
  "app.sidebar": Atom.make((get) => get(pluginReplacementAtoms["app.sidebar"]) !== undefined),
};

const PART_LABELS: { readonly [Part in PluginPartName]: string } = {
  "composer.controls": "the composer's control row",
  "app.pageFrame": "the Settings frame",
  "app.sidebar": "the sidebar",
};

// Parts a plugin asked to draw that this T3 doesn't have, as `PluginOwner`s.
const unknownParts = new Map<PluginOwner, string>();

const bumpReplacements = () =>
  appAtomRegistry.set(replacementsVersionAtom, appAtomRegistry.get(replacementsVersionAtom) + 1);

/**
 * Draws `part` with a plugin's component; returns the function that removes it. A part this T3
 * doesn't have is skipped with a note, because T3 renames a part instead of removing its pieces.
 */
export function registerPluginReplacement<Part extends PluginPartName>(
  part: Part,
  component: ComponentType<PluginPartProps<Part>>,
  owner: PluginOwner,
): () => void {
  if (!Object.hasOwn(replacements, part)) {
    const note = { ...owner };
    unknownParts.set(note, part);
    bumpReplacements();
    return () => {
      if (unknownParts.delete(note)) bumpReplacements();
    };
  }
  const list = replacements[part];
  const entry = { component, owner };
  list.push(entry);
  bumpReplacements();
  return () => {
    const index = list.indexOf(entry);
    if (index === -1) return;
    list.splice(index, 1);
    bumpReplacements();
  };
}

/** Why parts a plugin asked to draw show T3's or another plugin's drawing, by environment. */
export const pluginPartNotesAtom = Atom.family((pluginId: string) =>
  Atom.make((get): ReadonlyMap<string, ReadonlyArray<string>> => {
    get(replacementsVersionAtom);
    const notes = new Map<string, Set<string>>();
    const add = (environmentId: string, note: string) =>
      notes.set(environmentId, (notes.get(environmentId) ?? new Set()).add(note));
    for (const part of Object.keys(replacements) as Array<PluginPartName>) {
      const winner = winningEntry<{ readonly owner: PluginOwner }>(replacements[part])?.owner;
      for (const { owner } of replacements[part]) {
        if (owner.pluginId !== pluginId || winner === undefined || winner.pluginId === pluginId) {
          continue;
        }
        add(owner.environmentId, `${winner.pluginName} draws ${PART_LABELS[part]} instead.`);
      }
    }
    for (const [owner, part] of unknownParts) {
      if (owner.pluginId !== pluginId) continue;
      add(owner.environmentId, `This version of T3 Code has no "${part}" part to draw.`);
    }
    return new Map([...notes].map(([environmentId, set]) => [environmentId, [...set]]));
  }),
);

// The plugins, by contribution key, that asked the composer to fold on scroll.
const collapseOnScrollRequests = new Set<string>();

export function setPluginComposerCollapseOnScroll(key: string, enabled: boolean) {
  if (collapseOnScrollRequests.has(key) === enabled) return;
  if (enabled) collapseOnScrollRequests.add(key);
  else collapseOnScrollRequests.delete(key);
  bump();
}

export const pluginComposerCollapseOnScrollAtom = Atom.make((get) => {
  get(versionAtom);
  return collapseOnScrollRequests.size > 0;
});

/** The plugin that registered a contribution, so its failures show on that plugin's row. */
export interface PluginOwner {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
}
