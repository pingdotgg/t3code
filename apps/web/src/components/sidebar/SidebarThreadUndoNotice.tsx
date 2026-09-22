import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isEditableFocused } from "../../lib/editableFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command === "thread.undo" && undoLatestThreadAction()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  if (!notice) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");

  return (
    <div role="status" className="px-2 py-1.5 text-[11px] text-sidebar-muted-foreground">
      {notice.action} {notice.count} thread{notice.count === 1 ? "" : "s"},{" "}
      <button
        type="button"
        onClick={undoLatestThreadAction}
        className="cursor-pointer rounded-sm hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {shortcut ? `${shortcut} to undo` : "Undo"}
      </button>
    </div>
  );
}
