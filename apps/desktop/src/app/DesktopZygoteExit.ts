// @effect-diagnostics nodeBuiltinImport:off - Runs synchronously in the process "exit" event, after the Effect runtime has finished.
import * as NodeFS from "node:fs";

const MAX_WAIT_MS = 1000;

const readProc = (path: string): string | undefined => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

// Chromium launches helpers from its own threads, so each thread's children file is read.
const childPids = (pid: number): ReadonlyArray<number> => {
  let tasks: ReadonlyArray<string>;
  try {
    tasks = NodeFS.readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  return tasks.flatMap((task) =>
    (readProc(`/proc/${pid}/task/${task}/children`) ?? "")
      .split(" ")
      .filter((value) => value.trim() !== "")
      .map(Number),
  );
};

// A zygote rewrites its argv into one space-separated title.
const isZygote = (pid: number): boolean =>
  (readProc(`/proc/${pid}/cmdline`) ?? "")
    .replaceAll("\0", " ")
    .split(" ")
    .includes("--type=zygote");

// A zombie has already released its memory mappings.
const isRunning = (pid: number): boolean => {
  const stat = readProc(`/proc/${pid}/stat`);
  if (stat === undefined) return false;
  const state = stat.charAt(stat.lastIndexOf(")") + 2);
  return state !== "Z" && state !== "X";
};

/**
 * Chromium's zygotes exit only after the main process does, but the AppImage runtime unmounts
 * the image as soon as main exits, so a zygote that then faults in a code page dies with SIGBUS.
 */
export const stopZygotesBeforeExit = (pid: number): void => {
  const zygotes = childPids(pid).filter(isZygote);
  for (const zygote of zygotes) {
    try {
      process.kill(zygote, "SIGKILL");
    } catch {}
  }
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < MAX_WAIT_MS && zygotes.some(isRunning); waited++) {
    Atomics.wait(tick, 0, 0, 1);
  }
};
