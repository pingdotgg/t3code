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
} satisfies CliRendererConfig;

export interface TerminalStartupEnvironment {
  readonly TMUX?: string;
  readonly TMUX_PANE?: string;
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
