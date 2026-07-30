import * as NodeChildProcess from "node:child_process";

import type { CliRendererConfig } from "@opentui/core";

// These are application requirements, not optional renderer preferences. Keeping
// them explicit prevents a dependency-default change from turning the TUI into an
// inline surface or disabling wheel/click reporting.
export const TUI_RENDERER_CONFIG = {
  exitOnCtrlC: false,
  backgroundColor: "transparent",
  enableMouseMovement: false,
  useMouse: true,
  screenMode: "alternate-screen",
  // In SSH sessions the renderer flags itself remote and, unlike the local
  // path, forwards no environment to the native capability detection — so
  // TERM/COLORTERM are ignored, rgb/ansi256 stay false (no capability
  // handshake advertises truecolor), and every themed ANSI slot flattens to
  // the baked legacy palette. ssh forwards TERM and we default COLORTERM
  // (ensureColorCapabilityEnv), and both describe the viewer's terminal, so
  // hand them to the native layer explicitly. Harmless locally, where the
  // native side reads the same values from the real environ anyway.
  forwardEnvKeys: ["TERM", "COLORTERM", "TERM_PROGRAM"],
} satisfies CliRendererConfig;

export interface TerminalStartupEnvironment {
  readonly TMUX?: string;
  readonly TMUX_PANE?: string;
}

/**
 * OpenTUI only trusts the environment for colour capabilities: COLORTERM for
 * truecolor, a "256color" TERM for the 256-colour palette. Ghostty and friends
 * ship their own TERM values (e.g. `xterm-ghostty`) and the capability
 * handshake does not fill the gap, so when the shell drops COLORTERM the
 * renderer decides the terminal is 16-colour and flattens every themed ANSI
 * slot to its baked legacy palette (red → #800000, cyan → #008080, …) — the
 * whole UI silently loses the user's theme. Advertise truecolor for terminals
 * known to support it before the renderer reads the environment.
 *
 * Bun does not propagate `process.env` writes to the native environ that the
 * renderer's Zig layer reads, so the `t3 tui` Node parent injects the same
 * default at spawn time (`colorCapabilityEnv` in apps/server/src/cli/tui.ts).
 * This in-process call still covers JS-side consumers and any subprocesses the
 * TUI spawns.
 */
const TRUECOLOR_TERMINAL_PATTERN =
  /ghostty|kitty|wezterm|alacritty|foot|rio|contour|iterm|vscode|-direct/i;

export function ensureColorCapabilityEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.COLORTERM) return;
  if (
    TRUECOLOR_TERMINAL_PATTERN.test(env.TERM ?? "") ||
    TRUECOLOR_TERMINAL_PATTERN.test(env.TERM_PROGRAM ?? "")
  ) {
    env.COLORTERM = "truecolor";
  }
}

type RunTmux = (args: ReadonlyArray<string>) => void;

const runTmux: RunTmux = (args) => {
  NodeChildProcess.spawnSync("tmux", args, {
    stdio: "ignore",
    timeout: 500,
  });
};

/**
 * Make the pane show the live application before OpenTUI paints its first frame.
 *
 * tmux can leave a pane in copy mode when a TUI is started while its client is
 * scrolled into history. The application is running in the alternate screen in
 * that case, but tmux continues showing the old history until the user scrolls
 * back to the bottom. `copy-mode -q` is a safe no-op when the pane is already live.
 */
export function prepareTerminalViewport(
  environment?: TerminalStartupEnvironment,
  executeTmux: RunTmux = runTmux,
): void {
  const source =
    environment === undefined
      ? { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE }
      : environment;
  const pane = source.TMUX_PANE;
  if (!source.TMUX || !pane) return;

  try {
    executeTmux(["copy-mode", "-q", "-t", pane]);
  } catch {
    // Best effort: tmux may disappear between environment detection and launch.
  }
}
