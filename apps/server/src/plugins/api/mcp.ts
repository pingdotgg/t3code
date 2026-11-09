import type { PluginApi } from "@t3tools/plugin-sdk/server";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import * as PluginMcpTools from "../PluginMcpTools.ts";
import { type FacadeContext, pluginCodeScope } from "./facade.ts";

const isAccess = Schema.is(Schema.Literals(["read", "write"]));
const isJsonObject = Schema.is(Schema.JsonObject);
// Anthropic's API refuses a tool whose input schema combines schemas at its top level.
const TOP_LEVEL_COMBINATORS = ["anyOf", "oneOf", "allOf"];

export const makeMcpApi = (
  facade: FacadeContext,
  services: { readonly mcpTools: PluginMcpTools.PluginMcpTools["Service"] },
): PluginApi["mcp"] => {
  const { activation, pluginId } = facade;
  const deactivated = activation.controller.signal;
  let unregistersOnAbort = false;
  return {
    registerTool: (tool, handler) => {
      if (deactivated.aborted) throw new Error("This plugin activation has ended.");
      // Plugins are untyped JavaScript, and a misspelled access level must not open a write.
      if (!isAccess(tool.access)) {
        throw new TypeError(`Tool "${tool.name}" needs access "read" or "write".`);
      }
      // Model APIs reject a tool whose schema is not an object, which would fail every turn.
      if (
        typeof tool.description !== "string" ||
        !isJsonObject(tool.inputSchema) ||
        tool.inputSchema.type !== "object"
      ) {
        throw new TypeError(
          `Tool "${tool.name}" needs a description and an object JSON Schema for its input.`,
        );
      }
      const combinator = TOP_LEVEL_COMBINATORS.find((keyword) => keyword in tool.inputSchema);
      if (combinator !== undefined) {
        throw new TypeError(
          `Tool "${tool.name}" has ${combinator} at the top of its input schema, which model APIs refuse. Put the alternatives in a property instead.`,
        );
      }
      // Registering tells `/mcp` clients, which is T3's work, not the plugin's.
      const registered = pluginCodeScope.exit(() =>
        Effect.runSyncExitWith(facade.context)(
          services.mcpTools.register({
            pluginId,
            tool,
            handler: (input, { signal, threadId }) =>
              facade.asPlugin(() =>
                Promise.resolve().then(() =>
                  handler(input, { signal: AbortSignal.any([signal, deactivated]), threadId }),
                ),
              ),
            deactivated,
          }),
        ),
      );
      if (Exit.isFailure(registered)) {
        const error = Cause.squash(registered.cause);
        throw PluginMcpTools.isPluginMcpToolNameError(error)
          ? new TypeError(`"${tool.name}" is not a valid tool name. ${error.message}`)
          : error;
      }
      // Abort comes before any cleanup on deactivate, so a cleanup that hangs cannot keep tools live.
      if (!unregistersOnAbort) {
        unregistersOnAbort = true;
        deactivated.addEventListener(
          "abort",
          () => facade.fork(services.mcpTools.unregisterPlugin(pluginId)),
          { once: true },
        );
      }
    },
  };
};
