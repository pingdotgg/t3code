import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

/** Single-executable builds lack Node, so they use this subcommand instead of claudeHistoryWorker.mjs. */
export const claudeHistoryCommand = Command.make("__claude-history", {
  method: Argument.String("method"),
  sessionId: Argument.String("session-id"),
  options: Argument.String("options").pipe(Argument.optional),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ method, sessionId, options }) =>
    // Two effects, so an interrupt during the import never starts the worker.
    Effect.promise(() => import("../claudeHistoryWorker.ts")).pipe(
      Effect.flatMap(({ runClaudeHistoryWorker }) =>
        Effect.promise(() =>
          runClaudeHistoryWorker(
            method,
            sessionId,
            options._tag === "Some" ? options.value : undefined,
          ),
        ),
      ),
    ),
  ),
);
