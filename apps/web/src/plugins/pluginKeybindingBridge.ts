import type { PluginCatalogEntry } from "@t3tools/contracts";
import {
  PLUGIN_KEYBINDING_COMMAND_EVENT_TYPE,
  type PluginKeybindingCommandEventDetail,
} from "@t3tools/plugin-api/ui";
import { makePluginKeybindingCommand } from "@t3tools/shared/keybindings";

import { isPluginKeybindingCommand } from "../keybindings";
import { hasPluginManifest } from "./pluginCatalogEntry";

export function isActiveClientPluginKeybindingCommand(
  catalog: ReadonlyArray<PluginCatalogEntry>,
  command: string,
): boolean {
  for (const entry of catalog) {
    if (!hasPluginManifest(entry) || entry.status.status !== "active") continue;
    const matchesActiveCommand = entry.manifest.commands.some(
      (manifestCommand) =>
        manifestCommand.target === "client" &&
        manifestCommand.keybinding === true &&
        makePluginKeybindingCommand(entry.manifest.id, manifestCommand.name) === command,
    );
    if (matchesActiveCommand) return true;
  }
  return false;
}

export function claimPluginKeybindingCommand(
  catalog: ReadonlyArray<PluginCatalogEntry>,
  command: string,
  composerId?: string,
): boolean {
  if (!isPluginKeybindingCommand(command)) return false;
  if (!isActiveClientPluginKeybindingCommand(catalog, command)) return false;
  const detail: PluginKeybindingCommandEventDetail = {
    command,
    ...(composerId !== undefined ? { composerId } : {}),
  };
  window.dispatchEvent(
    new CustomEvent<PluginKeybindingCommandEventDetail>(PLUGIN_KEYBINDING_COMMAND_EVENT_TYPE, {
      detail,
    }),
  );
  return true;
}
