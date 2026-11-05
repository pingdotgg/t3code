import * as Effect from "effect/Effect";
import * as OrbitBroker from "../../OrbitBroker.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { OrbitToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(OrbitToolkit, {
  orbit: McpToolAccess.readsAsCaller((input) =>
    Effect.flatMap(OrbitBroker.OrbitBroker, (broker) => broker.invoke(input)),
  ),
});
