import { useEffect } from "react";

import { createEmacsReadlineKeydownHandler } from "../emacsReadlineBindings";
import { useClientSettings } from "../hooks/useSettings";

export function EmacsReadlineBindings() {
  const enabled = useClientSettings((settings) => settings.keyboardEditingMode === "emacs");

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = createEmacsReadlineKeydownHandler();
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled]);

  return null;
}
