// @effect-diagnostics nodeBuiltinImport:off -- Guarded reads require descriptor flags unavailable in FileSystem.
import * as NodeFS from "node:fs";

export const MAX_THEME_FILE_BYTES = 32 * 1024;

/**
 * Reads a theme file through one opened handle, so every check binds to the
 * file actually read rather than to a path that may have been swapped since:
 * O_NOFOLLOW rejects a symlink outright (a symlinked themes directory stays
 * usable, a symlinked file inside it does not), O_NONBLOCK keeps a FIFO from
 * blocking the open, and the fstat type and size gate examines the open
 * descriptor. Returns null for anything that is not a small regular file.
 *
 * Windows has neither flag (the constants are undefined, and OR-ing them in
 * is a no-op), so the symlink check there is an lstat before the open. That
 * leaves a window a swap could slip through, which the descriptor-bound
 * checks below then narrow to "a regular file at that path".
 */

export const readThemeFileGuarded = (filePath: string, maxBytes: number): string | null => {
  let fd: number;
  try {
    if (NodeFS.constants.O_NOFOLLOW === undefined && NodeFS.lstatSync(filePath).isSymbolicLink()) {
      return null;
    }
    fd = NodeFS.openSync(
      filePath,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const info = NodeFS.fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const contents = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = NodeFS.readSync(fd, contents, offset, contents.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return contents.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
};
