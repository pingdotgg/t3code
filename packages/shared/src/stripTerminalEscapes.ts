/**
 * Strip terminal escape sequences from captured CLI stdout.
 *
 * OpenCode's CLI (and potentially other provider CLIs) can emit OSC title
 * sequences (`ESC ]0;<title> BEL` / `ESC \`) and ANSI CSI color codes directly
 * to stdout, even when stdout is a pipe. When T3 Code captures that output
 * via `ChildProcessSpawner`, those bytes pollute structured parsing — e.g.
 * `opencode agent list` becomes `\x1b]0;t3code: ready\x07build (primary)`
 * instead of `build (primary)`, causing the agent inventory to store a
 * polluted id that later fails with `Agent not found`.
 *
 * This is defensive for any provider CLI; the regexes are intentionally
 * permissive and also handle Ghostty/Zsh title integrations that can leak
 * through `shell: true` spawns.
 */
const OSC_RE = /\x1b\].*?(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CHARSET_RE = /\x1b[()][A-Za-z0-9]/g;
const SINGLE_ESC_RE = /\x1b[@-Z\\-_]/g;

export function stripTerminalEscapes(input: string): string {
  if (!input || input.indexOf("\x1b") === -1) {
    return input;
  }
  return input
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(CHARSET_RE, "")
    .replace(SINGLE_ESC_RE, "");
}

/**
 * Strip escapes and also trim the result. Useful for single-value fields
 * like agent/variant names that should never contain control bytes.
 */
export function sanitizeTerminalValue(input: string): string {
  return stripTerminalEscapes(input).trim();
}
