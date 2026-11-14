/** Stops a dev server whose process tree outgrows a memory limit, so a leak cannot fill RAM and swap. */

import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const GiB = 1024 ** 3;

/** Half of RAM, at most 16 GiB. A fresh bundled-dev server uses about 7 GiB. */
export const defaultDevMemoryLimitBytes = (totalBytes = NodeOS.totalmem()) =>
  Math.min(16 * GiB, Math.floor(totalBytes / 2));

export class DevRunnerMemoryLimitError extends Schema.TaggedError<DevRunnerMemoryLimitError>()(
  "DevRunnerMemoryLimitError",
  { usedBytes: Schema.Number, limitBytes: Schema.Number },
) {
  override get message(): string {
    const gib = (bytes: number) => (bytes / GiB).toFixed(1);
    return `The dev server used ${gib(this.usedBytes)} GiB of RAM and swap, over its ${gib(this.limitBytes)} GiB limit, so it was stopped. Start it again, or set --memory-limit-gb (T3CODE_DEV_MEMORY_LIMIT_GB; 0 turns the limit off).`;
  }
}

export interface ProcessSample {
  readonly pid: number;
  readonly ppid: number;
}

/** `comm` can hold spaces and parentheses, so fields are read after its last `)`. */
export function parseProcStatParentPid(stat: string): number | undefined {
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

export function parseProcStatusBytes(status: string): number {
  const kib = (field: string) =>
    Number(new RegExp(`^${field}:\\s+(\\d+) kB`, "m").exec(status)?.[1] ?? 0);
  return (kib("VmRSS") + kib("VmSwap")) * 1024;
}

export function processTreePids(rootPid: number, processes: ReadonlyArray<ProcessSample>) {
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { pid, ppid } of processes) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return tree;
}

const readProcessTreeBytes = Effect.fn("DevRunner.readProcessTreeBytes")(function* (
  rootPid: number,
) {
  const fs = yield* FileSystem.FileSystem;
  // Processes exit between listing and reading, so each read may fail.
  const read = (path: string) => fs.readFileString(path).pipe(Effect.option);
  const entries = yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []));
  const pids = entries.filter((entry) => /^\d+$/.test(entry));
  const processes: ProcessSample[] = [];
  for (const pid of pids) {
    const stat = yield* read(`/proc/${pid}/stat`);
    const ppid = stat._tag === "Some" ? parseProcStatParentPid(stat.value) : undefined;
    if (ppid !== undefined) processes.push({ pid: Number(pid), ppid });
  }
  let bytes = 0;
  for (const pid of processTreePids(rootPid, processes)) {
    const status = yield* read(`/proc/${pid}/status`);
    if (status._tag === "Some") bytes += parseProcStatusBytes(status.value);
  }
  return bytes;
});

/**
 * Samples this process and its descendants every 30 seconds and fails once
 * they hold more than `limitBytes` of RAM plus swap. Linux only; elsewhere it
 * never completes.
 */
export const enforceDevMemoryLimit = Effect.fn("DevRunner.enforceDevMemoryLimit")(function* (
  limitBytes: number,
) {
  if ((yield* HostProcess.Platform) !== "linux" || limitBytes <= 0) return yield* Effect.never;
  while (true) {
    yield* Effect.sleep("30 seconds");
    const usedBytes = yield* readProcessTreeBytes(process.pid);
    if (usedBytes > limitBytes) {
      return yield* new DevRunnerMemoryLimitError({ usedBytes, limitBytes });
    }
  }
});
