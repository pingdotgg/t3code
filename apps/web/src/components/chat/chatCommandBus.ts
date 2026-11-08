import type { KeybindingCommand } from "@t3tools/contracts";

const CHAT_COMMAND_EVENT = "t3code:chat-command";

/** Runs a chat keybinding command from UI outside the chat, such as the tab bar. */
export function runChatCommand(command: KeybindingCommand): void {
  window.dispatchEvent(new CustomEvent<KeybindingCommand>(CHAT_COMMAND_EVENT, { detail: command }));
}

export function onChatCommand(listener: (command: KeybindingCommand) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<KeybindingCommand>).detail);
  window.addEventListener(CHAT_COMMAND_EVENT, handle);
  return () => window.removeEventListener(CHAT_COMMAND_EVENT, handle);
}
