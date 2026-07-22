import { useAtomValue } from "@effect/atom-react";
import { useEffectEvent, useLayoutEffect } from "react";

import { createEmacsReadlineKeydownHandler } from "../emacsReadlineBindings";
import { useClientSettings } from "../hooks/useSettings";
import { resolveCustomShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

export function EmacsReadlineBindings() {
  const enabled = useClientSettings((settings) => settings.keyboardEditingMode === "emacs");
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled) return;
    createEmacsReadlineKeydownHandler({
      shouldYieldToApplicationShortcut: (candidate) =>
        resolveCustomShortcutCommand(candidate, keybindings) !== null,
    })(event);
  });

  useLayoutEffect(() => {
    // Register once so settings hydration cannot move this capture listener
    // behind application shortcut handlers.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return null;
}
