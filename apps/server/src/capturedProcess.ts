import { type ChildProcess as ChildProcessHandle, spawn, spawnSync } from "node:child_process";

import { Data, Effect } from "effect";

export interface CapturedProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type CapturedProcessOutputMode = "error" | "truncate";
export type CapturedProcessCollectorMode = "concat" | "parts";

export interface CapturedProcessRunOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly maxOutputBytes: number;
  readonly outputMode: CapturedProcessOutputMode;
  readonly truncatedMarker?: string;
  readonly shell?: boolean;
  readonly collectorMode?: CapturedProcessCollectorMode;
  readonly timeoutBehavior?: "error" | "result";
}

export class CapturedProcessSpawnError extends Data.TaggedError("CapturedProcessSpawnError")<{
  readonly cause: unknown;
}> {}

export class CapturedProcessStdinError extends Data.TaggedError("CapturedProcessStdinError")<{
  readonly cause: unknown;
}> {}

export class CapturedProcessOutputLimitError extends Data.TaggedError(
  "CapturedProcessOutputLimitError",
)<{
  readonly stream: "stdout" | "stderr";
  readonly maxBytes: number;
}> {}

export class CapturedProcessTimeoutError extends Data.TaggedError("CapturedProcessTimeoutError")<{
  readonly timeoutMs: number;
}> {}

export type CapturedProcessError =
  | CapturedProcessSpawnError
  | CapturedProcessStdinError
  | CapturedProcessOutputLimitError
  | CapturedProcessTimeoutError;

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChild(child: ChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall back to direct kill if taskkill is unavailable.
    }
  }
  child.kill(signal);
}

interface OutputCollector {
  readonly append: (chunk: Buffer | string) => boolean;
  readonly finalize: () => {
    readonly text: string;
    readonly truncated: boolean;
  };
}

function makeConcatCollector(
  maxBytes: number,
  outputMode: CapturedProcessOutputMode,
): OutputCollector {
  let text = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (outputMode === "truncate") {
        const remaining = maxBytes - bytes;
        if (remaining <= 0) {
          truncated = true;
          return false;
        }
        if (chunkBuffer.length <= remaining) {
          text += chunkBuffer.toString();
          bytes += chunkBuffer.length;
          return false;
        }
        text += chunkBuffer.subarray(0, remaining).toString();
        bytes += remaining;
        truncated = true;
        return false;
      }

      text += chunkBuffer.toString();
      bytes += chunkBuffer.length;
      return bytes > maxBytes;
    },
    finalize() {
      return {
        text,
        truncated,
      };
    },
  };
}

function makePartsCollector(
  maxBytes: number,
  outputMode: CapturedProcessOutputMode,
  truncatedMarker: string,
): OutputCollector {
  const decoder = new TextDecoder();
  const parts: Array<string> = [];
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (truncated && outputMode === "truncate") {
        return false;
      }

      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const remainingBytes = maxBytes - bytes;

      if (remainingBytes <= 0) {
        if (outputMode === "truncate") {
          if (truncatedMarker.length > 0) {
            parts.push(truncatedMarker);
          }
          truncated = true;
          return false;
        }

        bytes += chunkBuffer.byteLength;
        return bytes > maxBytes;
      }

      const nextChunk =
        outputMode === "truncate" && chunkBuffer.byteLength > remainingBytes
          ? chunkBuffer.subarray(0, remainingBytes)
          : chunkBuffer;
      const nextPart = decoder.decode(nextChunk, { stream: true });
      if (nextPart.length > 0) {
        parts.push(nextPart);
      }
      bytes += nextChunk.byteLength;

      if (outputMode === "truncate" && chunkBuffer.byteLength > remainingBytes) {
        if (truncatedMarker.length > 0) {
          parts.push(truncatedMarker);
        }
        truncated = true;
        return false;
      }

      return outputMode === "error" && bytes > maxBytes;
    },
    finalize() {
      return {
        text: truncated ? parts.join("") : `${parts.join("")}${decoder.decode()}`,
        truncated,
      };
    },
  };
}

function makeOutputCollector(
  maxBytes: number,
  outputMode: CapturedProcessOutputMode,
  collectorMode: CapturedProcessCollectorMode,
  truncatedMarker: string,
): OutputCollector {
  if (collectorMode === "concat") {
    return makeConcatCollector(maxBytes, outputMode);
  }
  return makePartsCollector(maxBytes, outputMode, truncatedMarker);
}

function isCapturedProcessError(value: unknown): value is CapturedProcessError {
  return (
    value instanceof CapturedProcessSpawnError ||
    value instanceof CapturedProcessStdinError ||
    value instanceof CapturedProcessOutputLimitError ||
    value instanceof CapturedProcessTimeoutError
  );
}

async function runCapturedProcessPromise(
  command: string,
  args: readonly string[],
  options: CapturedProcessRunOptions,
): Promise<CapturedProcessResult> {
  const collectorMode = options.collectorMode ?? "concat";
  const truncatedMarker = options.truncatedMarker ?? "";
  const timeoutBehavior = options.timeoutBehavior ?? "error";

  return new Promise<CapturedProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      stdio: "pipe",
      shell: options.shell ?? false,
    });

    const stdout = makeOutputCollector(
      options.maxOutputBytes,
      options.outputMode,
      collectorMode,
      truncatedMarker,
    );
    const stderr = makeOutputCollector(
      options.maxOutputBytes,
      options.outputMode,
      collectorMode,
      truncatedMarker,
    );
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
      }, 1_000);
    }, options.timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };

    const fail = (error: CapturedProcessError): void => {
      killChild(child, "SIGTERM");
      finalize(() => reject(error));
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.append(chunk)) {
        fail(
          new CapturedProcessOutputLimitError({
            stream: "stdout",
            maxBytes: options.maxOutputBytes,
          }),
        );
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.append(chunk)) {
        fail(
          new CapturedProcessOutputLimitError({
            stream: "stderr",
            maxBytes: options.maxOutputBytes,
          }),
        );
      }
    });

    child.once("error", (cause) => {
      finalize(() => reject(new CapturedProcessSpawnError({ cause })));
    });

    child.once("close", (code, signal) => {
      const stdoutResult = stdout.finalize();
      const stderrResult = stderr.finalize();
      finalize(() => {
        if (timedOut && timeoutBehavior === "error") {
          reject(new CapturedProcessTimeoutError({ timeoutMs: options.timeoutMs }));
          return;
        }

        resolve({
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          code,
          signal,
          timedOut,
          stdoutTruncated: stdoutResult.truncated,
          stderrTruncated: stderrResult.truncated,
        });
      });
    });

    child.stdin?.once("error", (cause) => {
      fail(new CapturedProcessStdinError({ cause }));
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin, (cause) => {
        if (cause) {
          fail(new CapturedProcessStdinError({ cause }));
          return;
        }
        child.stdin?.end();
      });
      return;
    }

    child.stdin?.end();
  });
}

export function runCapturedProcess(
  command: string,
  args: readonly string[],
  options: CapturedProcessRunOptions,
): Effect.Effect<CapturedProcessResult, CapturedProcessError> {
  return Effect.tryPromise({
    try: () => runCapturedProcessPromise(command, args, options),
    catch: (cause) =>
      isCapturedProcessError(cause) ? cause : new CapturedProcessSpawnError({ cause }),
  });
}
