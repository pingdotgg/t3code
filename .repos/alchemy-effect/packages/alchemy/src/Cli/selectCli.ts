import * as Layer from "effect/Layer";
import type { Cli } from "./Cli.ts";
import { LoggingCli } from "./LoggingCli.ts";
import { inkCLI } from "./tui/InkCLI.tsx";

/**
 * Returns true when the current process looks like it's being driven by a
 * coding agent, CI runner, or anything else that won't render an interactive
 * TUI well. The Ink renderer repaints the screen on every event, which floods
 * agent transcripts with redundant frames; LoggingCli emits one line per
 * status change instead.
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

export const selectCli = (): Layer.Layer<Cli> =>
  isNonInteractive() ? LoggingCli : inkCLI();
