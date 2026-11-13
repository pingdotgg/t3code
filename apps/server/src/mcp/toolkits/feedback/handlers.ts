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
  t3_feedback_list: McpToolAccess.reads(() =>
    Feedback.FeedbackService.pipe(
      Effect.flatMap((feedback) => feedback.list),
      Effect.map((reports) => ({ reports })),
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    ),
  ),
});
