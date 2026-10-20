import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/**
 * Whether a stat describes a cloud-only placeholder: a file that has a size but
 * no data on disk, such as an online-only OneDrive, iCloud, or Dropbox file on
 * macOS (`SF_DATALESS`). Stat answers instantly, but reading one blocks until
 * the sync client downloads it, and a stalled client never does. Interrupting
 * the read does not help: the libuv thread stays stuck in `read()`, so a few
 * such reads exhaust the pool and every later file operation in the process hangs.
 *
 * Node does not expose `st_flags`, so this checks for zero allocated blocks.
 * A small APFS-compressed file stored inline can also report zero blocks; treat
 * a match as "do not read now", not as "this file is broken".
 */
export function isCloudPlaceholder(info: FileSystem.File.Info, platform: NodeJS.Platform): boolean {
  return (
    platform === "darwin" &&
    info.type === "File" &&
    info.size > 0n &&
    Option.getOrUndefined(info.blocks) === 0n
  );
}
