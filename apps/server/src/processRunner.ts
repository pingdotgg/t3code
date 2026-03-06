import {
  type ChildProcess as ChildProcessHandle,
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
  type StdioOptions,
} from "node:child_process";
import { extname, join } from "node:path";

import type { ServerRuntimeEnvironment } from "@t3tools/contracts";
import { Effect, Exit, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  resolveCommandCandidates,
  resolveExecutableFile,
  resolvePathEnvironmentVariable,
  resolveWindowsPathExtensions,
  stripWrappingQuotes,
} from "./commandResolution";
import { detectServerRuntimeEnvironment } from "./runtimeEnvironment";

interface ProcessSpawnBaseOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  runtimeEnvironment?: ServerRuntimeEnvironment | undefined;
  shell?: boolean | undefined;
}

interface RuntimeShellOptions {
  runtimeEnvironment?: ServerRuntimeEnvironment | undefined;
  shell?: boolean | string | undefined;
}

interface ProcessLaunchPlanOptions extends RuntimeShellOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
  inheritParentEnv?: boolean | undefined;
}

interface ProcessSpawnOptions extends ProcessSpawnBaseOptions {
  stdio?: StdioOptions | undefined;
  detached?: boolean | undefined;
}

export interface RuntimeCommandOptions extends ChildProcess.CommandOptions {
  runtimeEnvironment?: ServerRuntimeEnvironment | undefined;
}

interface ProcessSpawnSyncOptions extends ProcessSpawnBaseOptions {
  stdio?: StdioOptions | undefined;
  detached?: boolean | undefined;
  encoding?: BufferEncoding | undefined;
  input?: string | undefined;
}

export interface ProcessRunOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
  outputMode?: "error" | "truncate" | undefined;
  runtimeEnvironment?: ServerRuntimeEnvironment | undefined;
  shell?: boolean | undefined;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated?: boolean | undefined;
  stderrTruncated?: boolean | undefined;
}

export interface ProcessLaunchPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean | string;
  readonly runtimeEnvironment: ServerRuntimeEnvironment;
}

interface ResolvedWindowsCommand {
  readonly path: string;
  readonly kind: "native" | "batch";
}

const WINDOWS_BATCH_EXECUTABLE_EXTENSIONS = new Set([".CMD", ".BAT"]);

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function resolveRuntimeEnvironment(
  runtimeEnvironment: ServerRuntimeEnvironment | undefined,
): ServerRuntimeEnvironment {
  return runtimeEnvironment ?? detectServerRuntimeEnvironment();
}

function resolveEffectiveEnvironment(options: ProcessLaunchPlanOptions): NodeJS.ProcessEnv {
  const env = (options.env ?? {}) as NodeJS.ProcessEnv;
  if (options.inheritParentEnv === false) {
    return { ...env };
  }

  return {
    ...process.env,
    ...env,
  };
}

function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): ResolvedWindowsCommand | null {
  const windowsPathExtensions = resolveWindowsPathExtensions(env);
  const candidates = resolveCommandCandidates(command, "win32", windowsPathExtensions);

  const classify = (filePath: string): ResolvedWindowsCommand => {
    const extension = extname(filePath).toUpperCase();
    return {
      path: filePath,
      kind: WINDOWS_BATCH_EXECUTABLE_EXTENSIONS.has(extension) ? "batch" : "native",
    };
  };

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of candidates) {
      const resolvedCandidate = resolveExecutableFile(candidate, {
        platform: "win32",
        windowsPathExtensions,
        cwd,
      });
      if (resolvedCandidate) {
        return classify(resolvedCandidate);
      }
    }
    return null;
  }

  const pathEntries = resolvePathEnvironmentVariable(env)
    .split(";")
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of candidates) {
      const candidatePath = join(pathEntry, candidate);
      if (
        resolveExecutableFile(candidatePath, {
          platform: "win32",
          windowsPathExtensions,
        })
      ) {
        return classify(candidatePath);
      }
    }
  }

  return null;
}

function resolveWindowsCommandShell(env: NodeJS.ProcessEnv): string {
  return env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
}

export function resolveProcessLaunchPlan(
  command: string,
  args: ReadonlyArray<string>,
  options: ProcessLaunchPlanOptions = {},
): ProcessLaunchPlan {
  const runtimeEnvironment = resolveRuntimeEnvironment(options.runtimeEnvironment);
  if (options.shell !== undefined) {
    return {
      command,
      args: [...args],
      shell: options.shell,
      runtimeEnvironment,
    };
  }

  if (runtimeEnvironment.platform !== "windows") {
    return {
      command,
      args: [...args],
      shell: false,
      runtimeEnvironment,
    };
  }

  const env = resolveEffectiveEnvironment(options);
  const resolved = resolveWindowsCommand(command, env, options.cwd);
  if (!resolved) {
    return {
      command,
      args: [...args],
      shell: false,
      runtimeEnvironment,
    };
  }

  if (resolved.kind === "batch") {
    return {
      command: resolved.path,
      args: [...args],
      shell: resolveWindowsCommandShell(env),
      runtimeEnvironment,
    };
  }

  return {
    command: resolved.path,
    args: [...args],
    shell: false,
    runtimeEnvironment,
  };
}

function toSpawnOptions(
  options: ProcessSpawnOptions,
  launchPlan: ProcessLaunchPlan,
) {
  return {
    cwd: options.cwd,
    env: options.env,
    shell: launchPlan.shell,
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
    ...(options.detached !== undefined ? { detached: options.detached } : {}),
  };
}

function toRuntimeCommandOptions(
  options: RuntimeCommandOptions = {},
  shell: boolean | string,
): ChildProcess.CommandOptions {
  const { runtimeEnvironment: _runtimeEnvironment, shell: _shell, ...commandOptions } = options;
  return {
    ...commandOptions,
    shell,
  };
}

export function makeRuntimeCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: RuntimeCommandOptions = {},
): ChildProcess.StandardCommand {
  const launchPlan = resolveProcessLaunchPlan(command, args, {
    cwd: options.cwd,
    env: options.env,
    runtimeEnvironment: options.runtimeEnvironment,
    shell: options.shell,
    inheritParentEnv: options.extendEnv !== false,
  });
  return ChildProcess.make(launchPlan.command, launchPlan.args, {
    ...toRuntimeCommandOptions(options, launchPlan.shell),
  });
}

interface ManagedChildProcess {
  readonly scope: Scope.Closeable;
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
}

export const spawnManagedCommand = (command: ChildProcess.Command) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(command).pipe(
        Scope.provide(scope),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
      );

      return {
        scope,
        handle,
      } satisfies ManagedChildProcess;
    }),
  );

function spawnProcess(
  command: string,
  args: readonly string[],
  options: ProcessSpawnOptions = {},
): ChildProcessHandle {
  const launchPlan = resolveProcessLaunchPlan(command, args, {
    cwd: options.cwd,
    env: options.env,
    runtimeEnvironment: options.runtimeEnvironment,
    shell: options.shell,
    inheritParentEnv: options.env === undefined,
  });

  return spawn(launchPlan.command, launchPlan.args, toSpawnOptions(options, launchPlan));
}

function spawnPipedProcess(
  command: string,
  args: readonly string[],
  options: Omit<ProcessSpawnOptions, "stdio" | "detached"> = {},
): ChildProcessWithoutNullStreams {
  return spawnProcess(command, args, {
    ...options,
    stdio: "pipe",
  }) as ChildProcessWithoutNullStreams;
}

export function spawnProcessSync(
  command: string,
  args: readonly string[],
  options: ProcessSpawnSyncOptions = {},
) {
  const launchPlan = resolveProcessLaunchPlan(command, args, {
    cwd: options.cwd,
    env: options.env,
    runtimeEnvironment: options.runtimeEnvironment,
    shell: options.shell,
    inheritParentEnv: options.env === undefined,
  });

  return spawnSync(launchPlan.command, launchPlan.args, {
    cwd: options.cwd,
    env: options.env,
    shell: launchPlan.shell,
    encoding: options.encoding ?? "utf8",
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
    ...(options.detached !== undefined ? { detached: options.detached } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
}

export function spawnDetachedProcess(
  command: string,
  args: readonly string[],
  options: Omit<ProcessSpawnOptions, "stdio" | "detached"> = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, {
      ...options,
      detached: true,
      stdio: "ignore",
    });

    const cleanup = () => {
      child.off("spawn", handleSpawn);
      child.off("error", handleError);
    };

    const handleSpawn = () => {
      cleanup();
      child.unref();
      resolve();
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(normalizeSpawnError(command, args, error));
    };

    child.once("spawn", handleSpawn);
    child.once("error", handleError);
  });
}

function normalizeSpawnError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(`Failed to run ${commandLabel(command, args)}: ${error.message}`);
}

function isWindowsCommandNotFound(
  code: number | null,
  stderr: string,
  runtimeEnvironment?: ServerRuntimeEnvironment,
): boolean {
  if (resolveRuntimeEnvironment(runtimeEnvironment).platform !== "windows") return false;
  if (code === 9009) return true;
  return /is not recognized as an internal or external command/i.test(stderr);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
  runtimeEnvironment?: ServerRuntimeEnvironment,
): Error {
  if (isWindowsCommandNotFound(result.code, result.stderr, runtimeEnvironment)) {
    return new Error(`Command not found: ${command}`);
  }

  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(`Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeBufferError(
  command: string,
  args: readonly string[],
  stream: "stdout" | "stderr",
  maxBufferBytes: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} exceeded ${stream} buffer limit (${maxBufferBytes} bytes).`,
  );
}

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * On Windows, commands may still execute through a `cmd.exe` wrapper for
 * explicit shell usage or `.cmd` / `.bat` launchers. `child.kill()` only
 * terminates the wrapper, leaving the actual command running. Use
 * `taskkill /T` to kill the entire process tree instead.
 */
function killProcessTree(
  child: ChildProcessHandle,
  options: {
    runtimeEnvironment?: ServerRuntimeEnvironment | undefined;
    signal?: NodeJS.Signals | undefined;
  } = {},
): void {
  const signal = options.signal ?? "SIGTERM";
  if (
    resolveRuntimeEnvironment(options.runtimeEnvironment).platform === "windows" &&
    child.pid !== undefined
  ) {
    try {
      const result = spawnProcessSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
        runtimeEnvironment: options.runtimeEnvironment,
      });
      if (!result.error && result.status === 0) {
        return;
      }
      if (result.error) {
        throw result.error;
      }
    } catch {
      // fallback to direct kill
    }
  }
  child.kill(signal);
}

function appendChunkWithinLimit(
  target: string,
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): {
  next: string;
  nextBytes: number;
  truncated: boolean;
} {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { next: target, nextBytes: currentBytes, truncated: true };
  }
  if (chunk.length <= remaining) {
    return {
      next: `${target}${chunk.toString()}`,
      nextBytes: currentBytes + chunk.length,
      truncated: false,
    };
  }
  return {
    next: `${target}${chunk.subarray(0, remaining).toString()}`,
    nextBytes: currentBytes + remaining,
    truncated: true,
  };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const outputMode = options.outputMode ?? "error";

  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawnPipedProcess(command, args, options);

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, {
        runtimeEnvironment: options.runtimeEnvironment,
        signal: "SIGTERM",
      });
      forceKillTimer = setTimeout(() => {
        killProcessTree(child, {
          runtimeEnvironment: options.runtimeEnvironment,
          signal: "SIGKILL",
        });
      }, 1_000);
    }, timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };

    const fail = (error: Error): void => {
      killProcessTree(child, {
        runtimeEnvironment: options.runtimeEnvironment,
        signal: "SIGTERM",
      });
      finalize(() => {
        reject(error);
      });
    };

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): Error | null => {
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const text = chunkBuffer.toString();
      const byteLength = chunkBuffer.length;
      if (stream === "stdout") {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stdout, stdoutBytes, chunkBuffer, maxBufferBytes);
          stdout = appended.next;
          stdoutBytes = appended.nextBytes;
          stdoutTruncated = stdoutTruncated || appended.truncated;
          return null;
        }
        stdout += text;
        stdoutBytes += byteLength;
        if (stdoutBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stdout", maxBufferBytes);
        }
      } else {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stderr, stderrBytes, chunkBuffer, maxBufferBytes);
          stderr = appended.next;
          stderrBytes = appended.nextBytes;
          stderrTruncated = stderrTruncated || appended.truncated;
          return null;
        }
        stderr += text;
        stderrBytes += byteLength;
        if (stderrBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stderr", maxBufferBytes);
        }
      }
      return null;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stdout", chunk);
      if (error) {
        fail(error);
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const error = appendOutput("stderr", chunk);
      if (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      finalize(() => {
        reject(normalizeSpawnError(command, args, error));
      });
    });

    child.once("close", (code, signal) => {
      const result: ProcessRunResult = {
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      };

      finalize(() => {
        if (!options.allowNonZeroExit && (timedOut || (code !== null && code !== 0))) {
          reject(normalizeExitError(command, args, result, options.runtimeEnvironment));
          return;
        }
        resolve(result);
      });
    });

    child.stdin.once("error", (error) => {
      fail(normalizeStdinError(command, args, error));
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, (error) => {
        if (error) {
          fail(normalizeStdinError(command, args, error));
          return;
        }
        child.stdin.end();
      });
      return;
    }
    child.stdin.end();
  });
}
