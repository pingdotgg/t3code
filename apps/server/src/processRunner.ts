import { Effect, Match } from "effect";

import { runCapturedProcess } from "./capturedProcess.ts";

export interface ProcessRunOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
  outputMode?: "error" | "truncate" | undefined;
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

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
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

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

function hasWindowsCommandNotFoundMessage(output: string): boolean {
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output));
}

export function isWindowsCommandNotFound(code: number | null, stderr: string): boolean {
  if (process.platform !== "win32") return false;
  if (code === 9009) return true;
  return hasWindowsCommandNotFoundMessage(stderr);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  if (isWindowsCommandNotFound(result.code, result.stderr)) {
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

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const outputMode = options.outputMode ?? "error";
  const result = await Effect.runPromise(
    runCapturedProcess(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      timeoutMs,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      maxOutputBytes: maxBufferBytes,
      outputMode,
      shell: process.platform === "win32",
      collectorMode: "concat",
      timeoutBehavior: "result",
    }).pipe(
      Effect.mapError((error) =>
        Match.valueTags(error, {
          CapturedProcessSpawnError: ({ cause }) => normalizeSpawnError(command, args, cause),
          CapturedProcessStdinError: ({ cause }) => normalizeStdinError(command, args, cause),
          CapturedProcessOutputLimitError: ({ stream, maxBytes }) =>
            normalizeBufferError(command, args, stream, maxBytes),
          CapturedProcessTimeoutError: () => new Error(`${commandLabel(command, args)} timed out.`),
        }),
      ),
    ),
  );

  const normalizedResult: ProcessRunResult = {
    ...result,
  };

  if (
    !options.allowNonZeroExit &&
    (normalizedResult.timedOut || (normalizedResult.code !== null && normalizedResult.code !== 0))
  ) {
    throw normalizeExitError(command, args, normalizedResult);
  }

  return normalizedResult;
}
