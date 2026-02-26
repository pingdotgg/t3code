/**
 * Git process helpers - Effect-native git execution with typed errors.
 *
 * Centralizes child-process git invocation for server modules. This module
 * only executes git commands and reports structured failures.
 *
 * @module GitServiceLive
 */
import { Effect, Layer, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "../Errors.ts";
import {
  ExecuteGitInput,
  ExecuteGitResult,
  GitService,
  GitServiceShape,
} from "../Services/GitService.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

function toGitCommandError(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    cause instanceof GitCommandError
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

const collectOutput = Effect.fn(function* (
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, unknown>,
  maxOutputBytes: number,
): Effect.fn.Return<string, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        return yield* new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
        });
      }
      text += decoder.decode(chunk, { stream: true });
    }),
  ).pipe(Effect.mapError(toGitCommandError(input, "output stream failed.")));

  text += decoder.decode();
  return text;
});

const makeGitService = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const execute: GitServiceShape["execute"] = Effect.fnUntraced(function* (input) {
    const commandInput = {
      ...input,
      args: [...input.args],
    } as const;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const commandEffect = Effect.gen(function* () {
      const child = yield* commandSpawner
        .spawn(
          ChildProcess.make("git", commandInput.args, {
            cwd: commandInput.cwd,
            ...(input.env ? { env: input.env } : {}),
          }),
        )
        .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(commandInput, child.stdout, maxOutputBytes),
          collectOutput(commandInput, child.stderr, maxOutputBytes),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (!input.allowNonZeroExit && exitCode !== 0) {
        const trimmedStderr = stderr.trim();
        return yield* new GitCommandError({
          operation: commandInput.operation,
          command: quoteGitCommand(commandInput.args),
          cwd: commandInput.cwd,
          detail:
            trimmedStderr.length > 0
              ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
              : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
        });
      }

      return { code: exitCode, stdout, stderr } satisfies ExecuteGitResult;
    });

    return yield* commandEffect.pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.fail(
              new GitCommandError({
                operation: commandInput.operation,
                command: quoteGitCommand(commandInput.args),
                cwd: commandInput.cwd,
                detail: `${quoteGitCommand(commandInput.args)} timed out.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

  return {
    execute,
  } satisfies GitServiceShape;
});

export const GitServiceLive = Layer.effect(GitService, makeGitService);
