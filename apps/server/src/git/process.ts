/**
 * Git process helpers - Effect-native git execution with typed errors.
 *
 * Centralizes child-process git invocation for server modules. This module
 * only executes git commands and reports structured failures.
 *
 * @module GitProcess
 */
import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "./Errors.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export interface RunGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

function causeMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function gitError(
  input: Pick<RunGitInput, "operation" | "cwd" | "args">,
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation: input.operation,
    command: quoteGitCommand(input.args),
    cwd: input.cwd,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function collectOutput(
  input: Pick<RunGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, unknown>,
  maxOutputBytes: number,
): Effect.Effect<string, GitCommandError> {
  return Effect.gen(function* () {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";

    yield* Stream.runForEach(stream, (chunk) =>
      Effect.gen(function* () {
        bytes += chunk.byteLength;
        if (bytes > maxOutputBytes) {
          return yield* Effect.fail(
            gitError(
              input,
              `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
            ),
          );
        }
        text += decoder.decode(chunk, { stream: true });
      }),
    );

    text += decoder.decode();
    return text;
  }).pipe(
    Effect.mapError((cause) =>
      gitError(
        input,
        causeMessage(cause, `${quoteGitCommand(input.args)} output stream failed.`),
        cause,
      ),
    ),
  );
}

export function runGit(
  input: RunGitInput,
): Effect.Effect<GitRunResult, GitCommandError, ChildProcessSpawner.ChildProcessSpawner> {
  const normalizedCwd = input.cwd.trim();
  const commandInput = {
    ...input,
    cwd: normalizedCwd,
    args: [...input.args],
  } as const;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const commandEffect = Effect.gen(function* () {
    const child = yield* ChildProcess.spawn(
      ChildProcess.make("git", commandInput.args, {
        cwd: commandInput.cwd,
        ...(input.env ? { env: input.env } : {}),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        gitError(
          commandInput,
          causeMessage(cause, `Failed to spawn ${quoteGitCommand(commandInput.args)}.`),
          cause,
        ),
      ),
    );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectOutput(commandInput, child.stdout, maxOutputBytes),
        collectOutput(commandInput, child.stderr, maxOutputBytes),
        child.exitCode.pipe(
          Effect.map((value) => Number(value)),
          Effect.mapError((cause) =>
            gitError(
              commandInput,
              causeMessage(
                cause,
                `${quoteGitCommand(commandInput.args)} failed to report exit code.`,
              ),
              cause,
            ),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    if (!input.allowNonZeroExit && exitCode !== 0) {
      const trimmedStderr = stderr.trim();
      return yield* Effect.fail(
        gitError(
          commandInput,
          trimmedStderr.length > 0
            ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
            : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
        ),
      );
    }

    return {
      code: exitCode,
      stdout,
      stderr,
    } satisfies GitRunResult;
  });

  return commandEffect.pipe(
    Effect.scoped,
    Effect.timeoutOption(timeoutMs),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(gitError(commandInput, `${quoteGitCommand(commandInput.args)} timed out.`)),
        onSome: Effect.succeed,
      }),
    ),
  );
}
