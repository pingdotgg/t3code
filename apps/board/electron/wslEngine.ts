import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

export interface RunResult {
  /** Null when the process never started or was killed by the timeout. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunningProcess {
  readonly exited: Promise<number | null>;
  /** Stops the local process. Under wsl.exe that is the launcher; its Linux child ends with its stdin. */
  readonly kill: () => void;
}

interface ProcessOptions {
  readonly stdin?: string;
  readonly cwd?: string | undefined;
  /** Leaves stdin open, so the Linux child lives until this process is killed. */
  readonly holdStdin?: boolean;
}

/** The only place the app touches a real process, so tests replace just this. */
export interface ProcessRunner {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options: ProcessOptions & { readonly timeoutMs: number },
  ) => Promise<RunResult>;
  readonly start: (
    command: string,
    args: ReadonlyArray<string>,
    options: ProcessOptions,
  ) => RunningProcess;
}

// wsl.exe's own messages (--list among them) are UTF-16LE, while the Linux side is UTF-8.
function decode(chunks: ReadonlyArray<Buffer>): string {
  const bytes = Buffer.concat(chunks);
  return bytes.length >= 2 && bytes[1] === 0
    ? bytes.toString("utf16le").replace(/^\uFEFF/, "")
    : bytes.toString("utf8");
}

function spawnPiped(
  command: string,
  args: ReadonlyArray<string>,
  options: ProcessOptions,
): NodeChildProcess.ChildProcessWithoutNullStreams {
  const child = NodeChildProcess.spawn(command, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // A process that exits before reading its stdin raises EPIPE, which the exit code already reports.
  child.stdin.on("error", () => undefined);
  if (options.holdStdin !== true) child.stdin.end(options.stdin ?? "");
  return child;
}

export const nodeProcessRunner: ProcessRunner = {
  run: (command, args, options) => {
    const { promise, resolve } = Promise.withResolvers<RunResult>();
    const child = spawnPiped(command, args, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number | null, note = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: decode(stdout), stderr: decode(stderr) + note });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `timed out after ${options.timeoutMs} ms`);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
    return promise;
  },
  start: (command, args, options) => {
    const child = spawnPiped(command, args, options);
    const { promise: exited, resolve } = Promise.withResolvers<number | null>();
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
    return { exited, kill: () => void child.kill() };
  },
};

export interface LinuxHost {
  /** Runs one command. Argument values must not contain characters wsl.exe re-parses. */
  readonly exec: (
    argv: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number },
  ) => Promise<RunResult>;
  /** Runs a script on `sh`'s stdin, so quoting never crosses wsl.exe's command line. */
  readonly shell: (
    script: string,
    options?: { readonly loginPath?: boolean; readonly timeoutMs?: number },
  ) => Promise<RunResult>;
  /** Keeps the distro running until the returned process is killed. A no-op on Linux. */
  readonly hold: () => RunningProcess;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function createLinuxHost(options: {
  readonly platform: NodeJS.Platform;
  readonly distro: string | null;
  readonly runner: ProcessRunner;
}): LinuxHost {
  const { runner, distro } = options;
  // Not through the Windows shell: --exec skips the login shell, so PATH comes from the probe below.
  const invocation = (argv: ReadonlyArray<string>) =>
    options.platform === "win32"
      ? {
          command: "wsl.exe",
          args: [...(distro === null ? [] : ["-d", distro]), "--cd", "~", "--exec", ...argv],
          cwd: undefined,
        }
      : { command: argv[0] ?? "", args: argv.slice(1), cwd: NodeOS.homedir() };

  // A login shell loads version managers such as nvm, which is slow, so it runs once.
  let loginPath: Promise<string> | undefined;
  const readLoginPath = () => {
    loginPath ??= (async () => {
      const { command, args, cwd } = invocation(["bash", "-l", "-s"]);
      const result = await runner.run(command, args, {
        cwd,
        stdin: `printf 'resolvedPath:%s\\n' "$PATH"\n`,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      const line = result.stdout.split("\n").find((entry) => entry.startsWith("resolvedPath:"));
      const resolved = line?.slice("resolvedPath:".length).replace(/\r$/, "");
      return resolved ? `${SYSTEM_PATH}:${resolved}` : SYSTEM_PATH;
    })();
    return loginPath;
  };

  const withPath = async (script: string, wanted: boolean | undefined) =>
    wanted ? `export PATH=${shellQuote(await readLoginPath())}\n${script}` : script;

  return {
    exec: (argv, execOptions) => {
      const { command, args, cwd } = invocation(argv);
      return runner.run(command, args, {
        cwd,
        timeoutMs: execOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
    shell: async (script, shellOptions) => {
      const { command, args, cwd } = invocation(["sh", "-s"]);
      return runner.run(command, args, {
        cwd,
        stdin: await withPath(script, shellOptions?.loginPath),
        timeoutMs: shellOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    },
    // wsl.exe shuts a distro down once nothing runs in it, which would stop T3's service under the
    // app. `cat` on an open stdin idles until the launcher dies, then exits with its pipe.
    hold: () => {
      if (options.platform !== "win32")
        return { exited: Promise.resolve(0), kill: () => undefined };
      const { command, args } = invocation(["cat"]);
      return runner.start(command, args, { holdStdin: true });
    },
  };
}

export interface WslDistro {
  readonly name: string;
  readonly state: string;
  readonly version: number;
  readonly isDefault: boolean;
}

/** Parses `wsl.exe --list --verbose`. State names are localized, so only the shape is matched. */
export function parseDistroList(text: string): ReadonlyArray<WslDistro> {
  const distros: WslDistro[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (match?.[2] === undefined || match[3] === undefined || match[4] === undefined) continue;
    distros.push({
      name: match[2],
      state: match[3],
      version: Number(match[4]),
      isDefault: match[1] === "*",
    });
  }
  return distros;
}

export async function listDistros(runner: ProcessRunner): Promise<ReadonlyArray<WslDistro>> {
  const result = await runner.run("wsl.exe", ["--list", "--verbose"], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(`wsl.exe --list --verbose failed: ${result.stderr.trim() || "no output"}`);
  }
  return parseDistroList(result.stdout);
}

/** Null selects WSL's default distro. A configured name must be one `wsl.exe --list` reports. */
export async function resolveDistro(
  runner: ProcessRunner,
  configured: string | undefined,
): Promise<string | null> {
  if (configured === undefined || configured === "") return null;
  const distros = await listDistros(runner);
  if (!distros.some((distro) => distro.name === configured)) {
    const names = distros.map((distro) => distro.name).join(", ");
    throw new Error(`WSL distro "${configured}" is not installed. Installed: ${names}.`);
  }
  return configured;
}
