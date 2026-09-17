import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";

import { runClaudeHistoryWorker } from "../claudeHistoryWorker.ts";

/**
 * Hosts the Claude history worker inside the CLI executable. The npm bundle
 * runs it as a sibling `claudeHistoryWorker.mjs` under the host Node; the
 * single-executable has no Node to run a script with, so the adapter invokes
 * this hidden subcommand on its own executable instead.
 */
export const claudeHistoryCommand = Command.make("__claude-history", {
  method: Argument.string("method"),
  sessionId: Argument.string("session-id"),
  options: Argument.string("options").pipe(Argument.optional),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ method, sessionId, options }) =>
    Effect.promise(() =>
      runClaudeHistoryWorker(
        method,
        sessionId,
        options._tag === "Some" ? options.value : undefined,
      ),
    ),
  ),
);
