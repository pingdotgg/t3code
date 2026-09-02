/**
 * Build the hidden prompt sent when the user presses Continue after an
 * interrupted or failed turn. The prompt names the tool call that was cut
 * off so the agent resumes from that step instead of from vague memory.
 * Shared by web and mobile so both surfaces send the same words.
 */
export interface ContinuationPromptInput {
  /** Command that was running when the turn stopped, if any. */
  readonly command?: string | undefined;
  /** Directory the command ran in, when known. */
  readonly cwd?: string | undefined;
  /** Human label for a non-command tool call (e.g. "Changed files: src/a.ts"). */
  readonly toolLabel?: string | undefined;
  /** Why the turn ended: the user stopped it, or the provider failed. */
  readonly reason: "interrupted" | "error";
}

/**
 * Agents usually prefix commands with `cd <dir> && …`. Pull the directory
 * out so the prompt can say "in <dir>" and quote the real command.
 */
export function splitLeadingCdForPrompt(command: string): { cwd: string | null; command: string } {
  const match =
    /^\s*cd\s+("(?:[^"\\]|\\.)*"|'[^']*'|(?:[^\s;&|\\]|\\.)+)\s*(?:&&|;)\s*([\s\S]+)$/u.exec(
      command,
    );
  const dir = match?.[1];
  const rest = match?.[2]?.trim();
  if (!dir || !rest) return { cwd: null, command };
  const unquoted =
    (dir.startsWith('"') && dir.endsWith('"')) || (dir.startsWith("'") && dir.endsWith("'"))
      ? dir.slice(1, -1)
      : dir.replace(/\\(.)/g, "$1");
  return { cwd: unquoted, command: rest };
}

export function buildContinuationPrompt(input: ContinuationPromptInput): string {
  const opener =
    input.reason === "interrupted"
      ? "Your previous turn was stopped before it finished."
      : "Your previous turn ended with an error before it finished.";
  const where = input.command
    ? `You were running \`${input.command.trim()}\`${input.cwd ? ` in ${input.cwd}` : ""}.`
    : input.toolLabel
      ? `You were in the middle of: ${input.toolLabel.trim()}.`
      : null;
  return [
    opener,
    where,
    "Continue from that step. Do not repeat work that already completed, and do not re-run commands whose results are already in this conversation unless you need fresh output.",
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}
