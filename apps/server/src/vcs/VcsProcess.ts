import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  VcsOutputDecodeError,
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { ProcessRunner, layer as ProcessRunnerLive } from "../processRunner.ts";
import * as Match from "effect/Match";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spawnCwd?: string;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface VcsProcessShape {
  readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
}

export class VcsProcess extends Context.Service<VcsProcess, VcsProcessShape>()(
  "t3/vcs/VcsProcess",
) {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

function commandLabel(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

export const make = Effect.fn("makeVcsProcess")(function* () {
  const processRunner = yield* ProcessRunner;

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const label = commandLabel(input.command, input.args);
    const baseError = {
      operation: input.operation,
      command: label,
      cwd: input.cwd,
    };

    const result = yield* processRunner
      .run({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        ...(input.spawnCwd !== undefined ? { spawnCwd: input.spawnCwd } : {}),
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        truncatedMarker: input.appendTruncationMarker ? OUTPUT_TRUNCATED_MARKER : "",
        timeoutBehavior: "error",
      })
      .pipe(
        Effect.mapError(
          Match.valueTags({
            ProcessSpawnError: (error) =>
              VcsProcessSpawnError.fromProcessSpawnError(baseError, error),
            ProcessOutputLimitError: (error) =>
              VcsOutputDecodeError.fromProcessOutputLimitError(baseError, error),
            ProcessTimeoutError: (error) =>
              VcsProcessTimeoutError.fromProcessTimeoutError(baseError, error),
            ProcessStdinError: (error) =>
              VcsOutputDecodeError.fromProcessStdinError(baseError, error),
            ProcessReadError: (error) =>
              VcsOutputDecodeError.fromProcessReadError(baseError, error),
          }),
        ),
      );

    if (result.code === null) {
      return yield* VcsOutputDecodeError.missingExitCode(baseError);
    }

    if (!input.allowNonZeroExit && result.code !== 0) {
      return yield* new VcsProcessExitError({
        operation: input.operation,
        command: label,
        cwd: input.cwd,
        exitCode: result.code,
        detail: result.stderr.trim() || `${label} exited with code ${result.code}.`,
      });
    }

    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    } satisfies VcsProcessOutput;
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make()).pipe(Layer.provide(ProcessRunnerLive));
