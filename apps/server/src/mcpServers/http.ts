/**
 * HTTP surface for the MCP server inventory.
 *
 * Read-only: T3 Code reports what each harness will load, it does not write to
 * any harness config file.
 *
 * @module mcpServers/http
 */
import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerSettings from "../serverSettings.ts";
import { discoverGlobalMcpInventory } from "./McpServerInventory.ts";

export const mcpServersHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mcpServers",
  Effect.fnUntraced(function* (handlers) {
    const settingsService = yield* ServerSettings.ServerSettingsService;

    return handlers.handle(
      "inventory",
      Effect.fn("environment.mcpServers.inventory")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        // Read settings here rather than inside discovery so a settings failure
        // surfaces as the declared error instead of a defect.
        const settings = yield* settingsService.getSettings.pipe(
          Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
        );
        return yield* discoverGlobalMcpInventory(settings);
      }),
    );
  }),
);
