import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as WorkFilesTransfer from "../../../peer/WorkFilesTransfer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorkFilesToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(WorkFilesToolkit, {
  // Receiving files edits the checkout: no link below auto-accept-edits, no stopped caller.
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
        // A request the link narrowed (`T3-Mode-Limit`) is held to its narrower mode.
        const narrowed = McpInvocationContext.clientModeCeiling(scope.client).runtimeMode;
        const refusal =
          WorkFilesTransfer.receiveAccessRefusal(scope.client.access) ??
          (WorkFilesTransfer.receiveAccessRefusal(narrowed) === null
            ? null
            : `The thread sending these files runs in ${narrowed} mode, which cannot change files here; sending work files needs auto-accept-edits or broader.`);
        if (refusal !== null) {
          return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: refusal });
        }
        const transfer = yield* WorkFilesTransfer.WorkFilesTransfer;
        return yield* transfer.issueReceive({ request, sessionId: scope.client.sessionId });
      }),
    { linkedCallers: "allowed" },
  ),
});
