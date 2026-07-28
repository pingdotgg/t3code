import type { KeybindingCommand } from "@t3tools/contracts";

export function shouldHandleChatRouteShortcut(input: {
  readonly command: KeybindingCommand | null;
  readonly commandPaletteOpen: boolean;
}): boolean {
  return !input.commandPaletteOpen || input.command === "chat.new";
}

export function resolveChatNewShortcutBehavior(input: {
  readonly sidebarV2Enabled: boolean;
  readonly projectCount: number;
  readonly commandPaletteOpen: boolean;
}): "open-project-picker" | "create-immediately" | "dismiss-and-create" {
  if (input.sidebarV2Enabled && input.projectCount !== 1) {
    return "open-project-picker";
  }
  return input.commandPaletteOpen ? "dismiss-and-create" : "create-immediately";
}
