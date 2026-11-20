import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ParentSettlementFollow from "../../../orchestration-v2/ParentSettlementFollow.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PeerToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(PeerToolkit, {
  t3_peer_follow_parent_settlement: McpToolAccess.writes(
    (input) =>
      Effect.gen(function* () {
        const { client } = yield* McpInvocationContext.McpInvocationContext;
        // The parents' environment is the authenticated link's, never one the caller names.
        if (
          client?.linked !== true ||
          client.access !== "full-access" ||
          client.peerEnvironmentId === undefined
        ) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only another environment's full-access link settles children here.",
          });
        }
        const settlements = yield* ParentSettlementFollow.ParentSettlementFollow;
        return yield* settlements
          .follow({ ...input, parentEnvironmentId: client.peerEnvironmentId })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
      }),
    { linkedCallers: "allowed" },
  ),
});
