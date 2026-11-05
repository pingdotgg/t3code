import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ExternalHistory from "../../../project/externalHistory/ExternalHistory.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ExternalHistoryToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ExternalHistoryToolkit, {
  t3_external_history: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const history = yield* ExternalHistory.ExternalHistory;
      return yield* history.query(input.request).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.reason === "unavailable" ? "orchestration_error" : "invalid_request",
              message: error.message,
            }),
        ),
      );
    }),
  ),
});
