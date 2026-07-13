import * as NodeChildProcess from "node:child_process";

type TerminalEnvironment = Readonly<Record<string, string | undefined>>;

const KITTY_GRAPHICS_MARKERS = [
  "GHOSTTY_RESOURCES_DIR",
  "KITTY_WINDOW_ID",
  "KONSOLE_VERSION",
  "WEZTERM_PANE",
] as const;

const TERMINAL_NAME_KEYS = ["LC_TERMINAL", "TERM", "TERM_PROGRAM"] as const;
const KITTY_GRAPHICS_TERMINAL_NAME = /(?:^|[-_ ])(?:ghostty|kitty|konsole|wezterm)(?:$|[-_ ])/i;

function parseTmuxEnvironment(output: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    parsed[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return parsed;
}

/** True only for terminals known to implement the Kitty graphics protocol. */
export function isKnownKittyGraphicsTerminal(
  environment: TerminalEnvironment,
  tmuxEnvironmentOutput = "",
): boolean {
  const environments = [environment, parseTmuxEnvironment(tmuxEnvironmentOutput)];
  return environments.some(
    (candidate) =>
      KITTY_GRAPHICS_MARKERS.some((key) => Boolean(candidate[key])) ||
      TERMINAL_NAME_KEYS.some((key) =>
        KITTY_GRAPHICS_TERMINAL_NAME.test(candidate[key]?.trim() ?? ""),
      ),
  );
}

/**
 * tmux replaces TERM/TERM_PROGRAM in the pane, but keeps the client terminal's
 * original values in its global environment. Read that bounded local snapshot
 * so Ghostty-over-SSH can opt into graphics passthrough without guessing.
 */
export function detectKittyGraphicsTerminal(
  environment: TerminalEnvironment = process.env,
): boolean {
  if (!environment.TMUX) return isKnownKittyGraphicsTerminal(environment);
  const result = NodeChildProcess.spawnSync("tmux", ["show-environment", "-g"], {
    encoding: "utf8",
    timeout: 250,
    windowsHide: true,
  });
  const tmuxEnvironment = result.status === 0 ? (result.stdout ?? "") : "";
  return isKnownKittyGraphicsTerminal(environment, tmuxEnvironment);
}
