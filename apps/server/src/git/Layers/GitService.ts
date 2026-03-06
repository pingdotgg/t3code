/**
 * Git process helpers - runtime-aware git execution with typed errors.
 *
 * Centralizes child-process git invocation for server modules. This module
 * only executes git commands and reports structured failures.
 *
 * @module GitServiceLive
 */
import { Effect, Layer, Schema } from "effect";
import { runProcess } from "../../processRunner.ts";
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
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

export function normalizeGitProcessResult(
  commandInput: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  input: Pick<ExecuteGitInput, "allowNonZeroExit">,
  result: {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
  },
): ExecuteGitResult {
  if (result.timedOut) {
    throw new GitCommandError({
      operation: commandInput.operation,
      command: quoteGitCommand(commandInput.args),
      cwd: commandInput.cwd,
      detail: `${quoteGitCommand(commandInput.args)} timed out.`,
    });
  }

  if (result.code === null) {
    throw new GitCommandError({
      operation: commandInput.operation,
      command: quoteGitCommand(commandInput.args),
      cwd: commandInput.cwd,
      detail:
        result.signal !== null
          ? `${quoteGitCommand(commandInput.args)} terminated by signal ${result.signal}.`
          : `${quoteGitCommand(commandInput.args)} terminated before reporting an exit code.`,
    });
  }

  const exitCode = result.code;
  if (!input.allowNonZeroExit && exitCode !== 0) {
    const trimmedStderr = result.stderr.trim();
    throw new GitCommandError({
      operation: commandInput.operation,
      command: quoteGitCommand(commandInput.args),
      cwd: commandInput.cwd,
      detail:
        trimmedStderr.length > 0
          ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
          : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
    });
  }

  return {
    code: exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  } satisfies ExecuteGitResult;
}

const makeGitService = Effect.sync(() => {
  const execute: GitServiceShape["execute"] = Effect.fnUntraced(function* (input) {
    const commandInput = {
      ...input,
      args: [...input.args],
    } as const;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return yield* Effect.tryPromise({
      try: async () => {
        const result = await runProcess("git", commandInput.args, {
          cwd: commandInput.cwd,
          ...(input.env ? { env: input.env } : {}),
          timeoutMs,
          allowNonZeroExit: true,
          maxBufferBytes: maxOutputBytes,
          outputMode: "error",
        });

        return normalizeGitProcessResult(commandInput, input, result);
      },
      catch: toGitCommandError(commandInput, "failed to run."),
    });
  });

  return {
    execute,
  } satisfies GitServiceShape;
});

export const GitServiceLive = Layer.effect(GitService, makeGitService);
