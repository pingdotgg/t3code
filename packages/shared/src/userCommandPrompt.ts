import type { UserCommandSummary } from "@t3tools/contracts";

const USER_COMMAND_PROMPT = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/;

/**
 * The user commands a composer offers. The provider's own slash command keeps its name, so a
 * project cannot take over a command the user already types, such as `/review`.
 */
export function offeredUserCommands(
  commands: ReadonlyArray<UserCommandSummary>,
  providerCommands: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<UserCommandSummary> {
  if (commands.length === 0 || providerCommands.length === 0) return commands;
  const taken = new Set(providerCommands.map((command) => command.name));
  return commands.some((command) => taken.has(command.name))
    ? commands.filter((command) => !taken.has(command.name))
    : commands;
}

/** The command a prompt that is nothing but `/name args` runs, if the project offers one. */
export function parseUserCommandPrompt(
  prompt: string,
  commands: ReadonlyArray<UserCommandSummary>,
): { readonly command: UserCommandSummary; readonly args: string } | null {
  const match = USER_COMMAND_PROMPT.exec(prompt.trim());
  const command = match && commands.find((candidate) => candidate.name === match[1]);
  return match && command ? { command, args: (match[2] ?? "").trim() } : null;
}

/**
 * Whether a failed run request is known to have stopped before the program started. Any other
 * failure, such as a dropped connection, may come after the server began the run, whose output
 * still reaches the thread, so restoring the prompt would invite running it twice.
 */
export function userCommandNeverStarted(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "UserCommandError" &&
    "reason" in error &&
    (error.reason === "unknown-command" || error.reason === "thread-not-found")
  );
}
