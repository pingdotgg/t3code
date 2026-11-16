import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { McpToolCatalog, TOOL_GROUP_NAMES, TOOL_GROUPS } from "../../McpToolGroups.ts";
import { HelpToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HelpToolkit, {
  t3_help: McpToolAccess.readsAsCaller(({ path }) =>
    Effect.gen(function* () {
      const name = path
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/gu, "_");
      const catalog = yield* McpToolCatalog;
      const tools = yield* catalog.listed(
        TOOL_GROUPS.find((group) => group.name === name)?.tools ?? [name],
      );
      if (tools.length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `No tool is available for "${name}". Groups: ${TOOL_GROUP_NAMES}.`,
        });
      }
      return { tools };
    }),
  ),
});
