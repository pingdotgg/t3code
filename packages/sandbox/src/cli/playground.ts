#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import {
  DaytonaClientLive,
  SandboxServiceLive,
  TerminalService,
  TerminalServiceLive,
  type TerminalCleanupError,
} from "../index";
import { version } from "../../package.json" with { type: "json" };
import { getTerminalSize, runInteractiveTerminalSession } from "./terminal-session";

class PlaygroundCommandError extends Data.TaggedError("PlaygroundCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
}

const runPlaygroundProgram = Effect.gen(function* () {
  const terminalService = yield* TerminalService;
  const decoder = new TextDecoder();
  const { cols, rows } = getTerminalSize();

  const session = yield* terminalService.startPlaygroundSession({
    cols,
    rows,
    onData: (data: Uint8Array) => {
      process.stdout.write(decoder.decode(data));
    },
  });

  yield* Effect.addFinalizer(() =>
    session.cleanup.pipe(
      Effect.matchEffect({
        onFailure: (error: TerminalCleanupError) => Console.error(error.message),
        onSuccess: () => Effect.void,
      }),
    ),
  );

  yield* Console.log(`Connected to Daytona sandbox ${session.sandboxId}`);
  yield* Console.log(`PTY session ${session.sessionId}`);
  yield* Console.log("Type `exit` when you want to disconnect. The sandbox remains available.\n");
  yield* runInteractiveTerminalSession(session, []);
}).pipe(
  Effect.matchEffect({
    onFailure: (error) =>
      Effect.fail(
        new PlaygroundCommandError({
          message: formatUnknownError(error),
          cause: error instanceof Error && "cause" in error ? error.cause : undefined,
        }),
      ),
    onSuccess: (value) => Effect.succeed(value),
  }),
);

const playgroundCommand = Command.make("playground").pipe(
  Command.withDescription("Open an interactive Daytona PTY playground in your local terminal."),
  Command.withHandler(() => Effect.scoped(runPlaygroundProgram)),
);

Command.run(playgroundCommand, { version }).pipe(
  Effect.provide(TerminalServiceLive()),
  Effect.provide(SandboxServiceLive()),
  Effect.provide(DaytonaClientLive()),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
