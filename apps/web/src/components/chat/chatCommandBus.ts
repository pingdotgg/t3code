import type { KeybindingCommand } from "@t3tools/contracts";

import type { TerminalFocusOwner } from "../../lib/terminalFocus";

const CHAT_COMMAND_EVENT = "t3code:chat-command";

interface ChatCommandDetail {
  readonly command: KeybindingCommand;
  /** Where terminal commands act; omitted, they follow the focused terminal. */
  readonly terminalFocusOwner?: TerminalFocusOwner;
}

/** Runs a chat keybinding command from UI outside the chat, such as the tab bar. */
export function runChatCommand(
  command: KeybindingCommand,
  terminalFocusOwner?: TerminalFocusOwner,
): void {
  window.dispatchEvent(
    new CustomEvent<ChatCommandDetail>(CHAT_COMMAND_EVENT, {
      detail: { command, ...(terminalFocusOwner ? { terminalFocusOwner } : {}) },
    }),
  );
}

export function onChatCommand(listener: (detail: ChatCommandDetail) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<ChatCommandDetail>).detail);
  window.addEventListener(CHAT_COMMAND_EVENT, handle);
  return () => window.removeEventListener(CHAT_COMMAND_EVENT, handle);
}
