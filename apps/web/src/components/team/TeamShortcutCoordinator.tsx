import { useAtomValue } from "@effect/atom-react";
import { hasActiveTeamEnvironment } from "@t3tools/client-runtime/team";
import { useEffect, useEffectEvent } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand } from "~/keybindings";
import { isEditableFocused } from "~/lib/editableFocus";
import { isPreviewFocused } from "~/lib/previewFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { isModelPickerOpen } from "~/modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { toggleShowColleaguesThreads, useTeamStatesByEnvironment } from "~/state/team";

export function TeamShortcutCoordinator() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const teamStates = useTeamStatesByEnvironment();
  const hasTeam = hasActiveTeamEnvironment(teamStates);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      !hasTeam ||
      event.defaultPrevented ||
      event.repeat ||
      isCommandPaletteOpen() ||
      (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
    ) {
      return;
    }
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen: false,
        previewFocus: isPreviewFocused(),
        previewOpen: false,
        editableFocus: isEditableFocused(event.target),
        modelPickerOpen: isModelPickerOpen(),
      },
    });
    if (command !== "team.toggleColleagues") return;
    event.preventDefault();
    event.stopPropagation();
    toggleShowColleaguesThreads();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for the global team colleagues filter shortcut while a team environment is active
  useEffect(() => {
    if (!hasTeam) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [hasTeam]);

  return null;
}
