// @effect-diagnostics nodeBuiltinImport:off
// The service launcher shares this and runs without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

const BTRFS_SUPER_MAGIC = 0x9123683e;

async function onBtrfs(target: string): Promise<boolean> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Shared with the standalone launcher.
  if (process.platform !== "linux") return false;
  const stats = await NodeFSP.statfs(target).catch(() => undefined);
  return stats?.type === BTRFS_SUPER_MAGIC;
}

const run = (command: string, args: ReadonlyArray<string>) =>
  new Promise<string | undefined>((resolve) => {
    NodeChildProcess.execFile(command, args, (error, stdout) =>
      resolve(error === null ? stdout : undefined),
    );
  });

/**
 * SQLite rewrites pages in place, which fragments copy-on-write files on btrfs. Files created
 * in a No_COW directory inherit the flag, as systemd-journald does for its journals. Node has no
 * ioctl, so this runs chattr. Btrfs refuses reflinks between No_COW and copy-on-write files.
 */
export async function markNoCopyOnWrite(directory: string): Promise<void> {
  if (await onBtrfs(directory)) await run("chattr", ["+C", directory]);
}

export async function isNoCopyOnWrite(file: string): Promise<boolean> {
  if (!(await onBtrfs(file))) return false;
  // lsattr skips symlinks; its first field is the flag string, e.g. "---------------C------".
  const output = await run("lsattr", ["-d", await NodeFSP.realpath(file).catch(() => file)]);
  return output?.trimStart().split(/\s/, 1)[0]?.includes("C") ?? false;
}
