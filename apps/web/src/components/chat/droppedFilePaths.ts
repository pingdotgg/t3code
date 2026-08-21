/**
 * Files dropped from the OS that aren't images are handed to the agent by
 * *path*, not by content: it can open the file itself, so a 40MB recording or
 * a PDF never has to cross the wire as an attachment. This mirrors dropping a
 * file into a terminal, where the shell receives the path.
 *
 * Paths are only available in the desktop app (Electron's `webUtils`); in a
 * browser tab the File object carries no filesystem path at all.
 */

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
