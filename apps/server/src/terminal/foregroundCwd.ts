import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * The working directory of whatever runs in the foreground of `shellPid`'s terminal: the
 * shell at its prompt, or the program it started, such as a nested shell. Only Linux
 * answers, from procfs without spawning anything; elsewhere, or for a process that is gone,
 * the result is null.
 */
export const foregroundProcessCwd = Effect.fn("terminal.foregroundProcessCwd")(function* (
  shellPid: number,
  platform: NodeJS.Platform,
) {
  if (platform !== "linux") return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const readStat = (pid: number) =>
    fileSystem.readFileString(`/proc/${pid}/stat`).pipe(
      Effect.map((stat) => {
        // The command name can contain spaces and parentheses; field 22 is starttime.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const startTime = fields[19];
        return startTime && /^\d+$/.test(startTime)
          ? { startTime, foregroundGroup: Number(fields[5]) }
          : null;
      }),
      Effect.orElseSucceed(() => null),
    );
  const shell = yield* readStat(shellPid);
  if (shell === null) return null;
  const cwdOf = (pid: number) =>
    fileSystem.readLink(`/proc/${pid}/cwd`).pipe(Effect.orElseSucceed(() => null));
  const group = shell.foregroundGroup;
  let cwd: string | null = null;
  if (Number.isInteger(group) && group > 0 && group !== shellPid) {
    const before = yield* readStat(group);
    if (before !== null) {
      cwd = yield* cwdOf(group);
      const after = yield* readStat(group);
      if (after?.startTime !== before.startTime) return null;
    }
  }
  // A group whose leader already exited has no directory to read; the shell's stands in.
  cwd ??= yield* cwdOf(shellPid);
  const after = yield* readStat(shellPid);
  return after?.startTime === shell.startTime && after.foregroundGroup === group ? cwd : null;
});
