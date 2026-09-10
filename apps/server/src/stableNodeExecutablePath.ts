// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

/**
 * Absolute Node to persist in a service unit or to spawn a managed runtime.
 *
 * launchd and systemd cannot search PATH, so the path must be absolute.
 * `process.execPath` is the wrong absolute: Node realpaths Homebrew's prefix
 * symlink into a Cellar keg (`/opt/homebrew/Cellar/node/<ver>/bin/node`) whose
 * lifetime is one `brew upgrade`. Prefer `process.argv0` only when it is an
 * absolute non-keg path that resolves to the same executable as execPath
 * (`exec -a` can otherwise plant a nonexistent path in the unit). Otherwise
 * rewrite a keg execPath: unversioned formulas to `$prefix/bin/<name>`,
 * keg-only `node@*` to `$prefix/opt/<formula>/bin/<name>`.
 */
export function stableNodeExecutablePath(execPath: string, argv0?: string): string {
  if (argv0 !== undefined && isVerifiedDurableArgv0(argv0, execPath)) {
    return argv0;
  }
  return homebrewStableBinPath(execPath) ?? execPath;
}

function isVerifiedDurableArgv0(argv0: string, execPath: string): boolean {
  if (!argv0.startsWith("/") || homebrewStableBinPath(argv0) !== undefined) {
    return false;
  }
  return argv0RefersToExecPath(argv0, execPath);
}

function argv0RefersToExecPath(argv0: string, execPath: string): boolean {
  try {
    const argvStat = NodeFS.statSync(argv0);
    if (!argvStat.isFile() || (argvStat.mode & 0o111) === 0) {
      return false;
    }
    const execStat = NodeFS.statSync(execPath);
    if (argvStat.dev === execStat.dev && argvStat.ino === execStat.ino) {
      return true;
    }
    return NodeFS.realpathSync(argv0) === NodeFS.realpathSync(execPath);
  } catch {
    return false;
  }
}

/** `$prefix/Cellar|$Caskroom/$formula/$version/bin/$exe` → a prefix path that survives upgrades. */
function homebrewStableBinPath(filePath: string): string | undefined {
  const match = /^(.*)\/(?:cellar|caskroom)\/([^/]+)\/[^/]+\/bin\/([^/]+)$/i.exec(
    filePath.replaceAll("\\", "/"),
  );
  if (match === null) {
    return undefined;
  }
  const prefix = match[1]!;
  const formula = match[2]!;
  const executable = match[3]!;
  if (/^node@/i.test(formula)) {
    return `${prefix}/opt/${formula}/bin/${executable}`;
  }
  return `${prefix}/bin/${executable}`;
}
