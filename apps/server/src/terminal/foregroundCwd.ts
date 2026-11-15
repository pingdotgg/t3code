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
  const stat = yield* fileSystem
    .readFileString(`/proc/${shellPid}/stat`)
    .pipe(Effect.orElseSucceed(() => null));
  if (stat === null) return null;
  // The command name may hold spaces and parentheses, so fields count from its last `)`.
  // After it come state, ppid, pgrp, session, tty_nr and tpgid, the foreground group.
  const foregroundGroup = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
  const cwdOf = (pid: number) =>
    fileSystem.readLink(`/proc/${pid}/cwd`).pipe(Effect.orElseSucceed(() => null));
  // A group whose leader already exited has no directory to read; the shell's stands in.
  const foreground =
    Number.isInteger(foregroundGroup) && foregroundGroup > 0 ? yield* cwdOf(foregroundGroup) : null;
  return foreground ?? (yield* cwdOf(shellPid));
});
