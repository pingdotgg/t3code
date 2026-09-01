/**
 * Files dropped from the OS that aren't images are handed to the agent by
 * *path*, not by content: it can open the file itself, so a 40MB recording or
 * a PDF never has to cross the wire as an attachment. This mirrors dropping a
 * file into a terminal, where the shell receives the path.
 *
 * Paths are only available in the desktop app (Electron's `webUtils`); in a
 * browser tab the File object carries no filesystem path at all.
 *
 * A path is also only *meaningful* where the agent can open it. The desktop
 * bridge resolves a path on the machine the client runs on, so the path is
 * valid only when the thread's environment is that same machine — see
 * `droppedPathsResolveInEnvironment`.
 */

/**
 * Whether a filesystem path read from the local desktop bridge means anything
 * to the environment a thread runs in.
 *
 * The bridge resolves the path on *this* machine. `desktop-managed` is the one
 * environment the desktop app supervises here, so only a thread bound to that
 * environment shares the filesystem the path names. Every other connection —
 * a LAN or Tailscale host, a relay, a tunnel, another desktop acting as server
 * — runs the agent on a different machine, where the path either does not
 * exist or, worse, names a different file.
 *
 * Passing the ids explicitly keeps this pure: the caller reads the primary
 * environment, this decides.
 */
export function droppedPathsResolveInEnvironment(input: {
  readonly primarySource: string | undefined;
  readonly primaryEnvironmentId: string | undefined;
  readonly threadEnvironmentId: string | undefined;
}): boolean {
  if (input.primarySource !== "desktop-managed") {
    return false;
  }
  // Both ids must be known. A missing id is not a match: bootstrapping is not
  // evidence that the thread runs here, and guessing wrong inserts a path the
  // agent silently cannot read.
  return (
    input.primaryEnvironmentId !== undefined &&
    input.threadEnvironmentId !== undefined &&
    input.primaryEnvironmentId === input.threadEnvironmentId
  );
}

/**
 * Quote a path for the prompt when whitespace would make where it ends
 * ambiguous. This is prompt text, not a shell command — the goal is a clear
 * boundary for the reader, not shell-injection safety.
 */
export function quoteDroppedFilePath(path: string): string {
  if (!/\s/.test(path)) {
    return path;
  }
  // A double quote is legal in a POSIX filename, so escape any before wrapping —
  // otherwise the first inner quote reads as the closing delimiter.
  return `"${path.replace(/"/g, '\\"')}"`;
}

/**
 * The text inserted into the composer for a set of dropped paths. Entries that
 * are empty or all whitespace are skipped (a bridge that can't resolve a file
 * returns null, which the caller filters, but be defensive about "" too).
 * A path that survives is never altered: leading and trailing spaces are legal
 * in a filename, so trimming one would point the agent at a file that does not
 * exist. Quoting keeps such a path readable instead.
 */
export function formatDroppedFilePaths(paths: ReadonlyArray<string>): string {
  return paths
    .filter((path) => path.trim().length > 0)
    .map(quoteDroppedFilePath)
    .join(" ");
}
