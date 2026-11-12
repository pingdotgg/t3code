import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as WorkFilesTransfer from "../../../peer/WorkFilesTransfer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorkFilesToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(WorkFilesToolkit, {
  // The same access a launch from a link needs: no read-only link, no stopped caller.
  t3_work_files_receive: McpToolAccess.writes(
    (request) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (scope.client?.linked !== true) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only a linked environment can send work files here.",
          });
        }
        const transfer = yield* WorkFilesTransfer.WorkFilesTransfer;
        return yield* transfer.issueReceive({ request, sessionId: scope.client.sessionId });
      }),
    { linkedCallers: "allowed" },
  ),
});
