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
  return /\s/.test(path) ? `"${path}"` : path;
}

/**
 * The text inserted into the composer for a set of dropped paths. Empty and
 * whitespace-only paths are dropped (a bridge that can't resolve a file
 * returns null, which the caller filters, but be defensive about "" too).
 */
export function formatDroppedFilePaths(paths: ReadonlyArray<string>): string {
  return paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map(quoteDroppedFilePath)
    .join(" ");
}
