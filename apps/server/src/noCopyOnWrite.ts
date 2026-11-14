// @effect-diagnostics nodeBuiltinImport:off
// The service launcher shares this and runs without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

const BTRFS_SUPER_MAGIC = 0x9123683e;

/**
 * SQLite rewrites pages in place, which fragments copy-on-write files on btrfs. Files created
 * in a No_COW directory inherit the flag, as systemd-journald does for its journals. Node has no
 * ioctl, so this runs chattr; files that already have data keep copy-on-write. A btrfs reflink
 * fails between No_COW and copy-on-write files, so clone destinations need the flag too.
 */
export async function markNoCopyOnWrite(directory: string): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Shared with the standalone launcher.
  if (process.platform !== "linux") return;
  const stats = await NodeFSP.statfs(directory).catch(() => undefined);
  if (stats?.type !== BTRFS_SUPER_MAGIC) return;
  await new Promise<void>((resolve) => {
    NodeChildProcess.execFile("chattr", ["+C", directory], () => resolve());
  });
}
