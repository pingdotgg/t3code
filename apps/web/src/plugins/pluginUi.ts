import type { WebPluginParts } from "@t3tools/plugin-sdk/web";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import type { PluginUi } from "./pluginUiParts";

/**
 * The plugin UI code, which the plugin loader publishes once a plugin with a web part is active.
 * App code reaches plugin contributions only through this, so until then it downloads none of
 * that code and reads no plugin registry.
 */
export const pluginUiAtom = Atom.make<PluginUi | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-plugin-ui"),
);

const loadedPluginUi = () => appAtomRegistry.get(pluginUiAtom);

const NONE: ReadonlyArray<never> = [];

// Each atom below reads its namesake in `pluginRegistry` once plugin UI has loaded.
const fromPluginUi = <A>(pick: (ui: PluginUi) => Atom.Atom<A>, none: A) =>
  Atom.make((get) => {
    const ui = get(pluginUiAtom);
    return ui === null ? none : get(pick(ui));
  });

export const pluginCommandsAtom = fromPluginUi((ui) => ui.pluginCommandsAtom, NONE);

export const pluginPartReplacedAtom = Atom.family((part: keyof WebPluginParts) =>
  fromPluginUi((ui) => ui.pluginPartReplacedAtoms[part], false),
);

export const pluginComposerCollapseOnScrollAtom = fromPluginUi(
  (ui) => ui.pluginComposerCollapseOnScrollAtom,
  false,
);

export const pluginCommandLabel = (command: string) =>
  loadedPluginUi()?.pluginCommandLabel(command);
