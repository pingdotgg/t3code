import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

let chatSidebarShortcutKeybindings: ResolvedKeybindingsConfig | null = null;
const listeners = new Set<() => void>();
const notifyListeners = () => listeners.forEach((listener) => listener());

export function claimChatSidebarShortcut(keybindings: ResolvedKeybindingsConfig): () => void {
  chatSidebarShortcutKeybindings = keybindings;
  notifyListeners();

  return () => {
    if (chatSidebarShortcutKeybindings !== keybindings) return;
    chatSidebarShortcutKeybindings = null;
    notifyListeners();
  };
}

export const readChatSidebarShortcutKeybindings = () => chatSidebarShortcutKeybindings;

export function subscribeChatSidebarShortcut(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
