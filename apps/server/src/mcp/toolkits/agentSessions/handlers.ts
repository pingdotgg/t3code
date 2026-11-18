import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as AgentSessionImporter from "../../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../../project/AgentSessionScanner.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { AgentSessionsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(AgentSessionsToolkit, {
  t3_agent_sessions_scan: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* readCaller();
      const scanner = yield* AgentSessionScanner.AgentSessionScanner;
      return yield* scanner.scan.pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_agent_sessions_import: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      return yield* importer
        .importRecentAgentThreads(
          input,
          check.pipe(Effect.tap((caller) => caller.scope.client?.checkActive ?? Effect.void)),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "OrchestratorMcpFailure"
              ? error
              : error._tag === "AgentSessionImportProjectNotFoundError" ||
                  error._tag === "AgentSessionImportProjectChangedError"
                ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
                : unavailable(),
          ),
        );
    }),
  ),
});
