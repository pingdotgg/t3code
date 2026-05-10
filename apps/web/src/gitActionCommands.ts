import type { GitKeybindingCommand, KeybindingCommand } from "@forma/contracts";

export const GIT_ACTION_KEYBINDING_COMMANDS = [
  "git.init",
  "git.commit",
  "git.push",
  "git.pr",
  "git.publish",
] as const satisfies readonly GitKeybindingCommand[];

export function isGitActionKeybindingCommand(
  command: KeybindingCommand | string | null | undefined,
): command is GitKeybindingCommand {
  return (
    typeof command === "string" &&
    GIT_ACTION_KEYBINDING_COMMANDS.includes(command as GitKeybindingCommand)
  );
}
