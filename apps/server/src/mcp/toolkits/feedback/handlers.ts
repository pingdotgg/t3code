import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { FEEDBACK_CLI_CLIENT_LABEL } from "../../../feedback/FeedbackReport.ts";
import * as Feedback from "../../../feedback/FeedbackService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FeedbackToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(FeedbackToolkit, {
  t3_feedback: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const feedback = yield* Feedback.FeedbackService;
      return yield* feedback
        .submit(input, {
          source: scope.client?.label === FEEDBACK_CLI_CLIENT_LABEL ? "cli" : "mcp",
          ...(scope.thread === undefined ? {} : { threadId: scope.thread.threadId }),
        })
        .pipe(
          Effect.map((outcome) =>
            "status" in outcome
              ? outcome
              : {
                  ...outcome,
                  trace:
                    outcome.trace === null
                      ? null
                      : {
                          turns: outcome.trace.turns,
                          textTurns: outcome.trace.textTurns,
                          truncated: outcome.trace.truncated,
                        },
                },
          ),
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code:
                  error._tag === "FeedbackStorageError" ? "orchestration_error" : "invalid_request",
                message: error.message,
              }),
          ),
        );
    }),
  ),
});
