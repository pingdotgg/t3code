import { createContext } from "react";
import type { ShortcutMatchContext } from "../../keybindings";

export interface ChatShortcutContextValue {
  readonly hintContext: Partial<ShortcutMatchContext>;
  readonly getShortcutContext: (target: EventTarget | null) => Partial<ShortcutMatchContext>;
}

export const ChatShortcutContext = createContext<ChatShortcutContextValue | null>(null);
