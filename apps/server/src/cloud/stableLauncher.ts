// @effect-diagnostics nodeBuiltinImport:off -- Shared with the standalone launcher, which has no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * macOS TCC keys a launch agent's privacy grants to its program path, so launchd starts a copy
 * of the selected runtime's executable kept here. `__service-launcher` loads only Node built-ins,
 * so the executable alone is the launcher.
 */
export const stableLauncherPaths = (baseDir: string) => {
  const directory = NodePath.join(baseDir, "runtime", "launcher");
  return {
    directory,
    entryPath: NodePath.join(directory, "t3"),
    sentinelPath: NodePath.join(directory, ".install-complete"),
  };
};

// /bin/cp -c clones on APFS; Node's copyFile copies every byte on macOS.
const cloneFile = (source: string, destination: string) =>
  new Promise<boolean>((resolve) => {
    NodeChildProcess.execFile(
      "/bin/cp",
      ["-c", "-p", source, destination],
      { timeout: 60_000 },
      (error) => resolve(error === null),
    );
  });

/**
 * Callers hold the unit's selection lease. Each file is renamed over its predecessor, so the
 * program path never goes missing and a running launcher keeps its old inode.
 */
export async function publishStableLauncher(
  baseDir: string,
  sourceEntryPath: string,
  version: string,
): Promise<void> {
  const paths = stableLauncherPaths(baseDir);
  const stagedEntry = NodePath.join(paths.directory, ".t3.staged");
  const stagedSentinel = NodePath.join(paths.directory, ".install-complete.staged");
  await NodeFSP.mkdir(paths.directory, { recursive: true });
  try {
    await NodeFSP.rm(stagedEntry, { force: true });
    if (!(await cloneFile(sourceEntryPath, stagedEntry))) {
      await NodeFSP.copyFile(sourceEntryPath, stagedEntry);
    }
    await NodeFSP.writeFile(stagedSentinel, `${version}\n`);
    await syncPath(stagedEntry);
    await syncPath(stagedSentinel);
    await NodeFSP.rename(stagedEntry, paths.entryPath);
    await NodeFSP.rename(stagedSentinel, paths.sentinelPath);
    await syncPath(paths.directory);
  } finally {
    await NodeFSP.rm(stagedEntry, { force: true });
    await NodeFSP.rm(stagedSentinel, { force: true });
  }
}

// The unit is written durably right after this, so the program it names must be too.
async function syncPath(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
