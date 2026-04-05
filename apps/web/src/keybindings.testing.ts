import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { formatShortcutLabel, type ShortcutEventLike } from "./keybindings.shared";
import { resolveShortcutCommand } from "./keybindings";

const matchesCommandShortcut = (
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  command: string,
  options?: {
    platform?: string;
    context?: {
      terminalFocus?: boolean;
      terminalOpen?: boolean;
      [key: string]: boolean | undefined;
    };
  },
) => resolveShortcutCommand(event, keybindings, options) === command;

export { formatShortcutLabel, type ShortcutEventLike };

export const isTerminalToggleShortcut = (
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: Parameters<typeof resolveShortcutCommand>[2],
) => matchesCommandShortcut(event, keybindings, "terminal.toggle", options);

export const isTerminalSplitShortcut = (
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: Parameters<typeof resolveShortcutCommand>[2],
) => matchesCommandShortcut(event, keybindings, "terminal.split", options);

export const isTerminalNewShortcut = (
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: Parameters<typeof resolveShortcutCommand>[2],
) => matchesCommandShortcut(event, keybindings, "terminal.new", options);

export const isTerminalCloseShortcut = (
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: Parameters<typeof resolveShortcutCommand>[2],
) => matchesCommandShortcut(event, keybindings, "terminal.close", options);

export const isDiffToggleShortcut = (
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: Parameters<typeof resolveShortcutCommand>[2],
) => matchesCommandShortcut(event, keybindings, "diff.toggle", options);

export const isChatNewShortcut = (
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: Parameters<typeof resolveShortcutCommand>[2],
) => matchesCommandShortcut(event, keybindings, "chat.new", options);

export const isChatNewLocalShortcut = (
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: Parameters<typeof resolveShortcutCommand>[2],
) => matchesCommandShortcut(event, keybindings, "chat.newLocal", options);
