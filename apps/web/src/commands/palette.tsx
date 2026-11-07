import type { KeybindingCommand } from "@t3tools/contracts";
import {
  ChartNoAxesColumnIcon,
  CommandIcon,
  DiffIcon,
  MonitorIcon,
  PanelRightIcon,
  SquarePenIcon,
  TerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import type { ShortcutMatchContext } from "../keybindings";
import { queuePreviewFocusUrlFromPalette } from "../lib/previewFocusFromPalette";
import { queueTerminalToggleFromPalette } from "../lib/terminalToggleFromPalette";
import { queueWorkspaceFocusFromPalette } from "../lib/workspaceFocus";
import { executeCommand, listPaletteCommands } from "./registry";

function commandPaletteIcon(command: KeybindingCommand): ReactNode {
  const prefix = String(command).split(".")[0] ?? "";
  if (prefix === "terminal") return <TerminalIcon className={ITEM_ICON_CLASS} />;
  if (prefix === "workspace") return <MonitorIcon className={ITEM_ICON_CLASS} />;
  if (prefix === "rightPanel" || prefix === "threadPanel")
    return <PanelRightIcon className={ITEM_ICON_CLASS} />;
  if (prefix === "diff" || prefix === "preview") return <DiffIcon className={ITEM_ICON_CLASS} />;
  if (prefix === "chat" || prefix === "thread")
    return <SquarePenIcon className={ITEM_ICON_CLASS} />;
  if (prefix === "usage") return <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />;
  return <CommandIcon className={ITEM_ICON_CLASS} />;
}

export function buildRegistryPaletteActions(input: {
  readonly context: ShortcutMatchContext;
  /** Command ids that already have a custom/contextual palette row. */
  readonly exclude?: ReadonlySet<KeybindingCommand>;
  readonly icon?: (command: KeybindingCommand) => ReactNode;
}): CommandPaletteActionItem[] {
  const exclude = input.exclude ?? new Set();
  const icon = input.icon ?? commandPaletteIcon;
  return listPaletteCommands(input.context)
    .filter((command) => !exclude.has(command.id))
    .map((command) => ({
      kind: "action" as const,
      value: `command:${command.id}`,
      searchTerms: command.searchTerms,
      title: command.title,
      description: command.category,
      icon: icon(command.id),
      shortcutCommand: command.id,
      disabled: !command.enabled || !command.hasHandler,
      run: async () => {
        if (command.id === "terminal.toggle") {
          queueTerminalToggleFromPalette();
          return;
        }
        if (command.id === "workspace.focusNext") {
          queueWorkspaceFocusFromPalette(1);
          return;
        }
        if (command.id === "workspace.focusPrevious") {
          queueWorkspaceFocusFromPalette(-1);
          return;
        }
        if (command.id === "preview.focusUrl") {
          queuePreviewFocusUrlFromPalette();
          return;
        }
        executeCommand(command.id, { source: "palette" });
      },
    }));
}
