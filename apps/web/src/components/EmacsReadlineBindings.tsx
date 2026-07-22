import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { createEmacsReadlineKeydownHandler } from "../emacsReadlineBindings";
import { useClientSettings } from "../hooks/useSettings";
import { resolveShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

export function EmacsReadlineBindings() {
  const enabled = useClientSettings((settings) => settings.keyboardEditingMode === "emacs");
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = createEmacsReadlineKeydownHandler({
      shouldYieldToApplicationShortcut: (event) =>
        resolveShortcutCommand(event, keybindings) !== null,
    });
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled, keybindings]);

  return null;
}
