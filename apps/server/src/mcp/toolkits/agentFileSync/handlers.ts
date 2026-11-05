import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as AgentFileSync from "../../../agentFileSync/AgentFileSync.ts";
import * as AgentFileSyncLinks from "../../../agentFileSync/AgentFileSyncLinks.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { AgentFileSyncToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  const caller = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  if ((yield* environment.getDescriptor).environmentId !== caller.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
});

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const failure = (cause: unknown) => (isMcpFailure(cause) ? cause : unavailable());

export const layer = McpToolAccess.toLayer(AgentFileSyncToolkit, {
  t3_agent_files_list: McpToolAccess.reads((input) =>
    Effect.flatMap(AgentFileSync.AgentFileSync, (files) =>
      access.pipe(Effect.andThen(files.list(input))),
    ).pipe(Effect.mapError(failure)),
  ),
  t3_agent_files_export: McpToolAccess.reads((input) =>
    Effect.flatMap(AgentFileSync.AgentFileSync, (files) =>
      access.pipe(Effect.andThen(files.export(input))),
    ).pipe(Effect.mapError(failure)),
  ),
  t3_agent_files_preview: McpToolAccess.reads((input) =>
    Effect.flatMap(AgentFileSync.AgentFileSync, (files) =>
      access.pipe(Effect.andThen(files.preview(input))),
    ).pipe(Effect.mapError(failure)),
  ),
  t3_agent_files_sync_list: McpToolAccess.reads(() =>
    Effect.flatMap(AgentFileSyncLinks.AgentFileSyncLinks, (links) =>
      access.pipe(Effect.andThen(links.list)),
    ),
  ),
  t3_agent_files_sync_start: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(AgentFileSyncLinks.AgentFileSyncLinks, (links) =>
          links.subscribe(input, check.pipe(Effect.andThen(access))),
        ),
      ),
      Effect.mapError(failure),
    ),
  ),
  t3_agent_files_sync_manage: McpToolAccess.writesEnvironment((input, check) =>
    check.pipe(
      Effect.andThen(
        Effect.flatMap(AgentFileSyncLinks.AgentFileSyncLinks, (links) =>
          links.manage(input, check.pipe(Effect.andThen(access))),
        ),
      ),
      Effect.mapError(failure),
    ),
  ),
});
