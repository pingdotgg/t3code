import { spawn } from "node:child_process";

export interface ProcessRunOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeSpawnError(
  command: string,
  args: readonly string[],
  error: unknown,
): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(
    `Failed to run ${commandLabel(command, args)}: ${error.message}`,
  );
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(
  command: string,
  args: readonly string[],
  error: unknown,
): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(
    `Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`,
  );
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

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  return new Promise<ProcessRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
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
      child.kill("SIGTERM");
      finalize(() => {
        reject(error);
      });
    };

    const appendOutput = (
      stream: "stdout" | "stderr",
      chunk: Buffer | string,
    ): Error | null => {
      const text = chunk.toString();
      const byteLength = Buffer.byteLength(text);
      if (stream === "stdout") {
        stdout += text;
        stdoutBytes += byteLength;
        if (stdoutBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stdout", maxBufferBytes);
        }
      } else {
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
      };

      finalize(() => {
        if (
          !options.allowNonZeroExit &&
          (timedOut || (code !== null && code !== 0))
        ) {
          reject(normalizeExitError(command, args, result));
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
