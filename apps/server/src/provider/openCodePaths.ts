// @effect-diagnostics nodeBuiltinImport:off - pure path resolution shared by the probe and disk scanner.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Mirrors opencode's own data dir on every platform: `XDG_DATA_HOME`, else
 * `~/.local/share`. opencode applies no macOS/Windows special case here.
 */
export function resolveOpenCodeDataDir(environment?: NodeJS.ProcessEnv): string {
  const configuredHome = environment?.HOME;
  const home =
    configuredHome !== undefined && configuredHome.length > 0 ? configuredHome : NodeOS.homedir();
  const configuredDataHome = environment?.XDG_DATA_HOME;
  const base =
    configuredDataHome !== undefined && configuredDataHome.length > 0
      ? configuredDataHome
      : NodePath.join(home, ".local", "share");
  return NodePath.join(base, "opencode");
}
