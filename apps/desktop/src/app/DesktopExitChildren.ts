// @effect-diagnostics nodeBuiltinImport:off - Runs synchronously in the process "exit" event, where nothing async completes.
import * as NodeFS from "node:fs";

// Matches the backend's quit budget: SIGTERM, 5 s grace, SIGKILL, 1 s wait.
const TERMINATE_GRACE_MS = 5_000;
const KILL_WAIT_MS = 1_000;

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

// A zombie has already released its memory mappings.
const isRunning = (pid: number): boolean => {
  const stat = readProc(`/proc/${pid}/stat`);
  if (stat === undefined) return false;
  const state = stat.charAt(stat.lastIndexOf(")") + 2);
  return state !== "Z" && state !== "X";
};

const signal = (pids: ReadonlyArray<number>, name: NodeJS.Signals) => {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {}
  }
};

const waitUntilStopped = (pids: ReadonlyArray<number>, maxMs: number): ReadonlyArray<number> => {
  const tick = new Int32Array(new SharedArrayBuffer(4));
  let running = pids.filter(isRunning);
  for (let waited = 0; waited < maxMs && running.length > 0; waited += 10) {
    Atomics.wait(tick, 0, 0, 10);
    running = running.filter(isRunning);
  }
  return running;
};

/**
 * Stops the main process's children while it is still alive. On an AppImage the image unmounts
 * as soon as main exits, so children left running then die with SIGBUS. Linux only (/proc).
 * Returns the pids that needed SIGKILL.
 */
export const stopChildProcessesBeforeExit = (pid: number): ReadonlyArray<number> => {
  const children = childPids(pid);
  signal(children, "SIGTERM");
  const survivors = waitUntilStopped(children, TERMINATE_GRACE_MS);
  signal(survivors, "SIGKILL");
  waitUntilStopped(survivors, KILL_WAIT_MS);
  return survivors;
};
