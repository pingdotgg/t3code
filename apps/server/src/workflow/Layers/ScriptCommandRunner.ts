import type { TerminalEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { TerminalManager } from "../../terminal/Manager.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  ScriptCommandRunner,
  type ScriptCommandResult,
  type ScriptCommandRunnerShape,
} from "../Services/ScriptCommandRunner.ts";

const toRunnerError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const timeoutResult = {
  outcome: "timeout",
  exitCode: null,
  signal: null,
} satisfies ScriptCommandResult;

const cancelledResult = {
  outcome: "cancelled",
  exitCode: null,
  signal: null,
} satisfies ScriptCommandResult;

const wrapShellCommand = (run: string) => `${run}\nexit $?\r`;

const matchesRun = (
  event: TerminalEvent,
  input: {
    readonly scriptThreadId: string;
    readonly terminalId: string;
  },
) => event.threadId === input.scriptThreadId && event.terminalId === input.terminalId;

const make = Effect.gen(function* () {
  const terminals = yield* TerminalManager;

  const run: ScriptCommandRunnerShape["run"] = (input) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<ScriptCommandResult, WorkflowEventStoreError>();
      const complete = (result: ScriptCommandResult) =>
        Deferred.succeed(done, result).pipe(Effect.asVoid);
      // An errored terminal (PTY spawn failure, shell error) emits `error`
      // without a following `exited`/`closed`, so it must settle the deferred
      // too — otherwise the script step would block for the entire timeout and
      // then mislabel the real fault as a timeout. Fail fast with the message.
      const fail = (message: string) =>
        Deferred.fail(done, new WorkflowEventStoreError({ message })).pipe(Effect.asVoid);
      const closeTerminal = terminals
        .close({ threadId: input.scriptThreadId, terminalId: input.terminalId })
        .pipe(Effect.ignore);

      const unsubscribe = yield* terminals.subscribe((event) => {
        if (!matchesRun(event, input)) {
          return Effect.void;
        }
        if (event.type === "exited") {
          return complete({
            outcome: "exited",
            exitCode: event.exitCode ?? 1,
            signal: event.exitSignal,
          });
        }
        if (event.type === "error") {
          return fail(`script terminal error: ${event.message}`);
        }
        if (event.type === "closed") {
          return complete(cancelledResult);
        }
        return Effect.void;
      });

      const awaitTerminal = Deferred.await(done).pipe(
        Effect.timeoutOption(input.timeout),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () => closeTerminal.pipe(Effect.as(timeoutResult)),
            onSome: Effect.succeed,
          }),
        ),
      );

      return yield* Effect.gen(function* () {
        yield* terminals
          .open({
            threadId: input.scriptThreadId,
            terminalId: input.terminalId,
            cwd: input.cwd,
          })
          .pipe(Effect.mapError(toRunnerError("script terminal open failed")));
        yield* terminals
          .write({
            threadId: input.scriptThreadId,
            terminalId: input.terminalId,
            data: wrapShellCommand(input.run),
          })
          .pipe(Effect.mapError(toRunnerError("script terminal write failed")));
        return yield* awaitTerminal;
      }).pipe(
        Effect.onInterrupt(() => closeTerminal),
        Effect.ensuring(Effect.sync(unsubscribe)),
      );
    });

  return { run } satisfies ScriptCommandRunnerShape;
});

export const ScriptCommandRunnerLive = Layer.effect(ScriptCommandRunner, make);
