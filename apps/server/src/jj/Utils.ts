import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { Effect, Schema } from "effect";

import { GitCommandError } from "@t3tools/contracts";

export interface JjCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface RunJjCommandInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

function commandLabel(args: ReadonlyArray<string>): string {
  return ["jj", ...args].join(" ");
}

function toGitCommandError(input: {
  operation: string;
  cwd: string;
  args: ReadonlyArray<string>;
  detail: string;
  cause?: unknown;
}) {
  return new GitCommandError({
    operation: input.operation,
    command: commandLabel(input.args),
    cwd: input.cwd,
    detail: input.detail,
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
  });
}

function truncateOutput(
  value: string,
  maxOutputBytes: number,
): { text: string; truncated: boolean } {
  const byteLength = Buffer.byteLength(value);
  if (byteLength <= maxOutputBytes) {
    return { text: value, truncated: false };
  }

  let text = value;
  while (Buffer.byteLength(text) > maxOutputBytes) {
    text = text.slice(0, Math.max(0, Math.floor(text.length * 0.9)));
  }

  return {
    text: `${text}${OUTPUT_TRUNCATED_MARKER}`,
    truncated: true,
  };
}

function withSizeLimit(
  value: string,
  maxOutputBytes: number,
  truncateOutputAtMaxBytes: boolean,
): { text: string; truncated: boolean } {
  if (!truncateOutputAtMaxBytes) {
    return { text: value, truncated: false };
  }
  return truncateOutput(value, maxOutputBytes);
}

function isStaleWorkingCopyMessage(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("working copy is stale") ||
    normalized.includes("concurrent modification detected")
  );
}

function isGitCommandError(value: unknown): value is GitCommandError {
  return Schema.is(GitCommandError)(value);
}

const spawnCommand = Effect.fn("spawnCommand")(function* (
  command: string,
  input: RunJjCommandInput,
): Effect.fn.Return<JjCommandResult, GitCommandError> {
  return yield* Effect.tryPromise({
    try: () =>
      new Promise<JjCommandResult>((resolve, reject) => {
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        let stdout = "";
        let stderr = "";
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let finished = false;

        const child = spawn(command, [...input.args], {
          cwd: input.cwd,
          env: input.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const finish = (callback: () => void) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          callback();
        };

        const append = (
          chunk: Buffer,
          current: string,
          truncated: boolean,
        ): { value: string; truncated: boolean } => {
          if (truncated) {
            return { value: current, truncated: true };
          }

          const combined = current + chunk.toString("utf8");
          const limited = withSizeLimit(
            combined,
            maxOutputBytes,
            input.truncateOutputAtMaxBytes ?? false,
          );
          return {
            value: limited.text,
            truncated: limited.truncated,
          };
        };

        child.stdout.on("data", (chunk: Buffer | string) => {
          const next = append(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
            stdout,
            stdoutTruncated,
          );
          stdout = next.value;
          stdoutTruncated = next.truncated;
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          const next = append(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
            stderr,
            stderrTruncated,
          );
          stderr = next.value;
          stderrTruncated = next.truncated;
        });

        child.on("error", (cause) => {
          finish(() =>
            reject(
              toGitCommandError({
                operation: input.operation,
                cwd: input.cwd,
                args: input.args,
                detail:
                  cause instanceof Error && cause.message.toLowerCase().includes("enoent")
                    ? "Jujutsu CLI (`jj`) is required but not available on PATH."
                    : cause instanceof Error
                      ? cause.message
                      : String(cause),
                cause,
              }),
            ),
          );
        });

        child.on("close", (code) => {
          const result = {
            code: code ?? 1,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
          } satisfies JjCommandResult;

          if (result.code !== 0 && !input.allowNonZeroExit) {
            finish(() =>
              reject(
                toGitCommandError({
                  operation: input.operation,
                  cwd: input.cwd,
                  args: input.args,
                  detail:
                    result.stderr.trim().length > 0 ? result.stderr.trim() : `${command} failed`,
                }),
              ),
            );
            return;
          }

          finish(() => resolve(result));
        });

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(() =>
            reject(
              toGitCommandError({
                operation: input.operation,
                cwd: input.cwd,
                args: input.args,
                detail: `${command} timed out after ${timeoutMs}ms`,
              }),
            ),
          );
        }, timeoutMs);
      }),
    catch: (cause) =>
      isGitCommandError(cause)
        ? cause
        : toGitCommandError({
            operation: input.operation,
            cwd: input.cwd,
            args: input.args,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });
});

export const runJjCommand = Effect.fn("runJjCommand")(function* (
  input: RunJjCommandInput,
): Effect.fn.Return<JjCommandResult, GitCommandError> {
  const attempt = (shouldRetryStale: boolean) =>
    spawnCommand("jj", input).pipe(
      Effect.catch((error) => {
        if (!shouldRetryStale || !isStaleWorkingCopyMessage(error.detail)) {
          return Effect.fail(error);
        }

        return spawnCommand("jj", {
          operation: `${input.operation}.updateStale`,
          cwd: input.cwd,
          args: ["workspace", "update-stale"],
          allowNonZeroExit: false,
        }).pipe(Effect.flatMap(() => spawnCommand("jj", input)));
      }),
    );

  return yield* attempt(true);
});

export const runJjStdout = Effect.fn("runJjStdout")(function* (
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: Omit<RunJjCommandInput, "operation" | "cwd" | "args">,
): Effect.fn.Return<string, GitCommandError> {
  const result = yield* runJjCommand({
    operation,
    cwd,
    args,
    ...options,
  });
  return result.stdout;
});

export const resolveJjRoot = (cwd: string) =>
  runJjStdout("Jj.resolveRoot", cwd, ["root"]).pipe(
    Effect.map((stdout) => stdout.trim()),
    Effect.mapError((error) =>
      toGitCommandError({
        operation: "Jj.resolveRoot",
        cwd,
        args: ["root"],
        detail: error.detail,
        cause: error,
      }),
    ),
  );

export const resolveJjRepoDir = (cwd: string) =>
  resolveJjRoot(cwd).pipe(
    Effect.flatMap((workspaceRoot) =>
      Effect.tryPromise({
        try: async () => {
          const repoPointerPath = path.join(workspaceRoot, ".jj", "repo");
          try {
            const repoPointerStats = await fsPromises.stat(repoPointerPath);
            if (repoPointerStats.isFile()) {
              const repoDir = (await fsPromises.readFile(repoPointerPath, "utf8")).trim();
              if (repoDir.length > 0) {
                return repoDir;
              }
            }
          } catch {
            // Fall back to the default repo location inside the workspace root.
          }

          return path.join(workspaceRoot, ".jj", "repo");
        },
        catch: (cause) =>
          toGitCommandError({
            operation: "Jj.resolveRepoDir",
            cwd,
            args: ["root"],
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    ),
  );

export const readJjRepoBackendType = (cwd: string) =>
  resolveJjRepoDir(cwd).pipe(
    Effect.flatMap((repoDir) =>
      Effect.tryPromise({
        try: async () => {
          const backendTypePath = path.join(repoDir, "store", "type");
          return (await fsPromises.readFile(backendTypePath, "utf8")).trim();
        },
        catch: (cause) =>
          toGitCommandError({
            operation: "Jj.readRepoBackendType",
            cwd,
            args: ["root"],
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    ),
  );

export function formatJjConfigKeySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(segment)
    ? segment
    : `"${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function branchConfigKey(branch: string, key: string): string {
  return `branch.${formatJjConfigKeySegment(branch)}.${key}`;
}

export function parseMergeRefBranchName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  const refsHeadsPrefix = "refs/heads/";
  return trimmed.startsWith(refsHeadsPrefix) ? trimmed.slice(refsHeadsPrefix.length) : trimmed;
}

export function canonicalizePath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

export function parseJsonLines<T>(stdout: string): T[] {
  return stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}
