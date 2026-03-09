import { Effect, Layer, Schema } from "effect";

import { runProcess } from "../../processRunner.ts";
import { VcsCommandError } from "../Errors.ts";
import {
  VcsProcess,
  type ExecuteVcsProcessInput,
  type ExecuteVcsProcessResult,
  type VcsProcessShape,
} from "../Services/VcsProcess.ts";

function quoteCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

function toVcsCommandError(
  input: Pick<ExecuteVcsProcessInput, "operation" | "command" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(VcsCommandError)(cause)
      ? cause
      : new VcsCommandError({
          operation: input.operation,
          command: quoteCommand(input.command, input.args),
          cwd: input.cwd,
          detail,
          ...(cause !== undefined ? { cause } : {}),
        });
}

const execute: VcsProcessShape["execute"] = (input) =>
  Effect.tryPromise({
    try: async () => {
      const result = await runProcess(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.timeoutMs,
        allowNonZeroExit: input.allowNonZeroExit,
      });
      return {
        code: result.code ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      } satisfies ExecuteVcsProcessResult;
    },
    catch: toVcsCommandError(input, `${quoteCommand(input.command, input.args)} failed to execute.`),
  });

const makeVcsProcess = Effect.succeed({ execute } satisfies VcsProcessShape);

export const VcsProcessLive = Layer.effect(VcsProcess, makeVcsProcess);
