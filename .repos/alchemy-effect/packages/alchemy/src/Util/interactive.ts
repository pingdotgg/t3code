/**
 * Returns true when the current process looks like it's being driven by a
 * coding agent, CI runner, test runner, or anything else that won't render an
 * interactive TUI / prompt well.
 *
 * Two callers rely on this:
 *  - `Cli/selectCli.ts` uses it to pick `LoggingCli` over the Ink TUI.
 *  - `Auth/Profile.ts` uses it to refuse to launch an interactive credential
 *    configure flow (and thus avoid acquiring an auth lockfile) when there's
 *    no TTY to drive the prompts.
 *
 * Kept in `Util` (rather than `Cli`) so `Auth` can depend on it without
 * pulling in the CLI layer.
 */
export const isNonInteractive = (): boolean => {
  const env = process.env;
  if (env.ALCHEMY_PLAIN === "1" || env.ALCHEMY_NO_TUI === "1") return true;
  if (env.ALCHEMY_TUI === "1") return false;
  if (!process.stdout.isTTY) return true;
  if (env.CI) return true;
  // Known coding-agent env vars. These are best-effort — the isTTY check
  // above already catches most cases since agents typically pipe stdout.
  if (
    env.CLAUDECODE ||
    env.CLAUDE_CODE_ENTRYPOINT ||
    env.CURSOR_AGENT ||
    env.AIDER_MODEL ||
    env.CODEX_CLI
  )
    return true;
  return false;
};
