import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { PlaygroundSession, PtyInputError, PtyResizeError } from "../index";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 30;
const CTRL_C_EXIT_CODE = 130;

type StdinChunk = string | Uint8Array;

export function getTerminalSize() {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;

  return {
    cols: typeof cols === "number" && cols > 0 ? cols : DEFAULT_COLUMNS,
    rows: typeof rows === "number" && rows > 0 ? rows : DEFAULT_ROWS,
  };
}

function supportsRawMode(): boolean {
  return process.stdin.isTTY === true && typeof process.stdin.setRawMode === "function";
}

function isCtrlC(chunk: StdinChunk): boolean {
  if (typeof chunk === "string") {
    return chunk === "\u0003";
  }

  return chunk.length === 1 && chunk[0] === 3;
}

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

function setupLocalTerminal(session: PlaygroundSession, exitSignal: Deferred.Deferred<number>) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const useRawMode = supportsRawMode();
      let stdinResumed = false;

      const forwardInput = (chunk: StdinChunk) => {
        if (isCtrlC(chunk)) {
          Effect.runFork(Deferred.succeed(exitSignal, CTRL_C_EXIT_CODE));
          return;
        }

        Effect.runFork(
          session.sendInput(chunk).pipe(
            Effect.matchEffect({
              onFailure: (error: PtyInputError) =>
                Console.error(`${error.message}\n${formatUnknownError(error.cause)}`).pipe(
                  Effect.andThen(Deferred.succeed(exitSignal, 1)),
                  Effect.asVoid,
                ),
              onSuccess: () => Effect.void,
            }),
          ),
        );
      };

      const resizeTerminal = () => {
        const cols = process.stdout.columns;
        const rows = process.stdout.rows;

        if (typeof cols !== "number" || cols < 1) {
          return;
        }

        if (typeof rows !== "number" || rows < 1) {
          return;
        }

        Effect.runFork(
          session.resize(cols, rows).pipe(
            Effect.matchEffect({
              onFailure: (error: PtyResizeError) =>
                Console.error(`${error.message}\n${formatUnknownError(error.cause)}`),
              onSuccess: () => Effect.void,
            }),
          ),
        );
      };

      const exitOnSignal = () => {
        Effect.runFork(Deferred.succeed(exitSignal, CTRL_C_EXIT_CODE));
      };

      if (useRawMode) {
        process.stdin.setRawMode(true);
      }

      process.stdin.resume();
      stdinResumed = true;
      process.stdin.on("data", forwardInput);
      process.stdout.on("resize", resizeTerminal);
      process.on("SIGINT", exitOnSignal);
      process.on("SIGTERM", exitOnSignal);

      return () => {
        if (useRawMode) {
          process.stdin.setRawMode(false);
        }

        if (stdinResumed) {
          process.stdin.pause();
        }

        process.stdin.off("data", forwardInput);
        process.stdout.off("resize", resizeTerminal);
        process.off("SIGINT", exitOnSignal);
        process.off("SIGTERM", exitOnSignal);
      };
    }),
    (restoreTerminal) => Effect.sync(restoreTerminal),
  ).pipe(Effect.asVoid);
}

export function runInteractiveTerminalSession(
  session: PlaygroundSession,
  headerLines: ReadonlyArray<string>,
) {
  return Effect.gen(function* () {
    for (const line of headerLines) {
      yield* Console.log(line);
    }

    const exitSignal = yield* Deferred.make<number>();
    yield* setupLocalTerminal(session, exitSignal);

    const exitCode: number = yield* Effect.race(
      session.wait.pipe(
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            if (result.error) {
              yield* Console.error(`Daytona PTY exited with an error: ${result.error}`);
            }

            if (typeof result.exitCode === "number") {
              return result.exitCode;
            }

            return result.error ? 1 : 0;
          }),
        ),
      ),
      Deferred.await(exitSignal),
    );

    yield* Effect.sync(() => {
      process.exitCode = exitCode;
    });
  });
}
