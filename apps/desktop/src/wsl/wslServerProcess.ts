// Killing wsl.exe does not reach the Linux server: its parent is WSL's /init
// relay, not wsl.exe. A server that outlives the hangup keeps the T3 home
// locked, and the replacement the desktop starts next exits as "already
// running". So the desktop launches the server through a wrapper that reports
// the Linux pid, and on stop signals that pid itself and waits for it to exit.

export interface WslServerProcess {
  readonly pid: number;
  // Field 22 of /proc/<pid>/stat. Recorded so a stop never signals a process
  // that reused the pid after the server exited.
  readonly startTime: string;
}

const MARKER = "t3code-wsl-server-process";
const MARKER_PATTERN = new RegExp(`${MARKER} (\\d+) (\\d+)\\n`);
// wsl.exe can print its own warnings ahead of the wrapper's line. The line is
// written before the server starts, so it is never far in.
const MAX_SCAN_LENGTH = 16 * 1024;

// Prints the start time of a live, non-zombie process. A zombie has already
// exited and released its locks; only its parent has not reaped it yet.
const START_TIME_FUNCTION =
  't3_start_time() { read -r s 2>/dev/null </proc/$1/stat || return 1; set -- ${s##*)}; [ "$1" != Z ] || return 1; shift 19; echo "$1"; }';

// `exec` keeps the pid, so the shell's own pid and start time are the server's.
const LAUNCH_SCRIPT = `${START_TIME_FUNCTION}; echo ${MARKER} $$ $(t3_start_time $$) >&2; exec "$@"`;

export const wrapWslServerLaunch = (command: ReadonlyArray<string>): ReadonlyArray<string> => [
  "sh",
  "-c",
  LAUNCH_SCRIPT,
  "sh",
  ...command,
];

export interface WslServerProcessScan {
  readonly text: string;
  readonly process: WslServerProcess | null;
}

export const initialWslServerProcessScan: WslServerProcessScan = { text: "", process: null };

const textDecoder = new TextDecoder();

export const scanWslServerStderr = (
  scan: WslServerProcessScan,
  chunk: Uint8Array,
): WslServerProcessScan => {
  if (scan.process !== null || scan.text.length >= MAX_SCAN_LENGTH) return scan;
  const text = scan.text + textDecoder.decode(chunk);
  const match = MARKER_PATTERN.exec(text);
  if (match === null) return { text: text.slice(0, MAX_SCAN_LENGTH), process: null };
  return { text: "", process: { pid: Number(match[1]), startTime: match[2]! } };
};

export const WSL_SERVER_STOP_EXIT_CODE = {
  exited: 0,
  notRunning: 10,
  timedOut: 11,
} as const;

export const buildWslServerStopScript = (process: WslServerProcess, graceMillis: number): string =>
  [
    START_TIME_FUNCTION,
    `pid=${process.pid}`,
    `expected=${process.startTime}`,
    `[ "$(t3_start_time $pid)" = "$expected" ] || exit ${WSL_SERVER_STOP_EXIT_CODE.notRunning}`,
    `kill -TERM $pid 2>/dev/null || exit ${WSL_SERVER_STOP_EXIT_CODE.notRunning}`,
    `polls=${Math.max(1, Math.ceil(graceMillis / 100))}`,
    'while [ "$(t3_start_time $pid)" = "$expected" ]; do',
    `  [ $polls -gt 0 ] || exit ${WSL_SERVER_STOP_EXIT_CODE.timedOut}`,
    "  polls=$((polls - 1))",
    "  sleep 0.1",
    "done",
    `exit ${WSL_SERVER_STOP_EXIT_CODE.exited}`,
    "",
  ].join("\n");
