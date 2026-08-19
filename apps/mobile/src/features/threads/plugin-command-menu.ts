import type { PluginCommand } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandPopover";

export const isCollapsedComposerSelection = (selection: {
  readonly start: number;
  readonly end: number;
}): boolean => selection.start === selection.end;

export function reconcileComposerSelectionForTextChange(
  selection: { readonly start: number; readonly end: number },
  previousLength: number,
  nextLength: number,
): { readonly start: number; readonly end: number } {
  if (selection.start === previousLength && selection.end === previousLength) {
    return { start: nextLength, end: nextLength };
  }
  return {
    start: Math.min(selection.start, nextLength),
    end: Math.min(selection.end, nextLength),
  };
}

export function buildMobilePluginCommandItems(
  commands: ReadonlyArray<PluginCommand>,
  query: string,
): ComposerCommandItem[] {
  const normalizedQuery = query.toLowerCase();
  return commands
    .filter(
      (command) =>
        command.surfaces.includes("mobile") &&
        `${command.label} ${command.description ?? ""} ${command.id}`
          .toLowerCase()
          .includes(normalizedQuery),
    )
    .map((command) => ({
      id: `plugin-command:${command.id}`,
      type: "plugin-command" as const,
      command,
      label: command.label,
      description: command.description ?? "Plugin command",
    }));
}
