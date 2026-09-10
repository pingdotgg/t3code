import type { KeybindingCommand } from "@t3tools/contracts";

import type { PaneSplitDirection } from "./splitPaneTree";

export type WorkspacePaneShortcutAction =
  | { readonly _tag: "Split"; readonly direction: PaneSplitDirection }
  | { readonly _tag: "Focus"; readonly direction: PaneSplitDirection }
  | { readonly _tag: "ToggleMaximized" };

/** Converts configurable keybinding commands into pane-domain operations. */
export function workspacePaneShortcutAction(
  command: KeybindingCommand,
): WorkspacePaneShortcutAction | null {
  switch (command) {
    case "pane.splitLeft":
      return { _tag: "Split", direction: "left" };
    case "pane.splitDown":
      return { _tag: "Split", direction: "down" };
    case "pane.splitUp":
      return { _tag: "Split", direction: "up" };
    case "pane.splitRight":
      return { _tag: "Split", direction: "right" };
    case "pane.focusLeft":
      return { _tag: "Focus", direction: "left" };
    case "pane.focusDown":
      return { _tag: "Focus", direction: "down" };
    case "pane.focusUp":
      return { _tag: "Focus", direction: "up" };
    case "pane.focusRight":
      return { _tag: "Focus", direction: "right" };
    case "pane.toggleMaximized":
      return { _tag: "ToggleMaximized" };
    default:
      return null;
  }
}
