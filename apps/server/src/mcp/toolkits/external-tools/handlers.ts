import * as Effect from "effect/Effect";
import * as ExternalToolBroker from "../../ExternalToolBroker.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ExternalToolToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ExternalToolToolkit, {
  external_tool: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(ExternalToolBroker.ExternalToolBroker, (broker) => broker.invoke(input)),
  ),
});
