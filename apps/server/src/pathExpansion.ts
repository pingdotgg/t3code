// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as Path from "effect/Path";

/**
 * Expand a leading `~` (or `~/…`, `~\…`) in a user-supplied path to the
 * current user's home directory. Spawned processes don't get shell
 * expansion, so env vars like `CODEX_HOME=~/.codex-work` would be passed
 * verbatim and treated as relative paths by the receiver.
 *
 * Matches the behavior of the other `expandHomePath` helpers in the
 * workspace layers and CLI bootstrap: `~` alone and both `~/` and `~\`
 * separators are handled. Returns the input unchanged if it doesn't
 * start with `~` or is empty. Does not handle `~user` (other-user)
 * expansion.
 */
export function expandHomePath(value: string): string {
  if (!value) return value;
  if (value === "~") return NodeOS.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Same expansion as `expandHomePath`, but joins with a caller-supplied
 * `Path.Path` service instead of `node:path`. Use this inside Effect code that
 * already has `Path.Path` in context so the platform layer stays in control of
 * separator handling.
 */
export function expandHomePathWith(value: string, path: Path.Path): string {
  if (value === "~") {
    return NodeOS.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Inverse of `expandHomePath` for display: a path at or below the current
 * user's home directory is shown as `~` or `~/…`. Anything else is returned
 * unchanged, so callers can print server paths without leaking a long home
 * prefix into every label.
 */
export function collapseHomePath(value: string): string {
  const home = NodeOS.homedir();
  if (value === home) return "~";
  for (const separator of ["/", "\\"]) {
    if (value.startsWith(home + separator)) {
      return `~${separator}${value.slice(home.length + 1)}`;
    }
  }
  return value;
}
