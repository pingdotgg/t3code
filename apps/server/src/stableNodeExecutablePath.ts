/**
 * Absolute Node to persist in a service unit or to spawn a managed runtime.
 *
 * launchd and systemd cannot search PATH, so the path must be absolute.
 * `process.execPath` is the wrong absolute: Node realpaths Homebrew's prefix
 * symlink into a Cellar keg (`/opt/homebrew/Cellar/node/<ver>/bin/node`) whose
 * lifetime is one `brew upgrade`. Prefer the original invocation path when it
 * is already a non-keg absolute (`process.argv0`, e.g. `/opt/homebrew/bin/node`
 * or `/opt/homebrew/opt/node@22/bin/node`), otherwise rewrite a keg execPath to
 * `$prefix/bin/<name>`.
 */
export function stableNodeExecutablePath(execPath: string, argv0?: string): string {
  if (argv0 !== undefined && isDurableAbsoluteNodePath(argv0)) {
    return argv0;
  }
  return homebrewPrefixBinPath(execPath) ?? execPath;
}

function isDurableAbsoluteNodePath(filePath: string): boolean {
  return filePath.startsWith("/") && homebrewPrefixBinPath(filePath) === undefined;
}

/** `$prefix/Cellar|$Caskroom/$name/$version/bin/$exe` → `$prefix/bin/$exe`. */
function homebrewPrefixBinPath(filePath: string): string | undefined {
  const match = /^(.*)\/(?:cellar|caskroom)\/[^/]+\/[^/]+\/bin\/([^/]+)$/i.exec(
    filePath.replaceAll("\\", "/"),
  );
  if (match === null) {
    return undefined;
  }
  return `${match[1]}/bin/${match[2]}`;
}
