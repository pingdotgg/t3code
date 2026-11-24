import {
  McpAppRequestError,
  type McpAppCallToolResult,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { mcpAppToolCallableByApp } from "@t3tools/shared/mcpApp";
import { mcpAppFromToolItem, T3_WIDGET_SERVER } from "@t3tools/shared/toolOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { PluginProxy } from "./PluginProxy.ts";
import { PluginService } from "./PluginService.ts";
import { PluginStore } from "./PluginStore.ts";
import { WidgetPublisher } from "./WidgetDocument.ts";
import { widgetCall, WidgetTools } from "./WidgetTools.ts";

/**
 * What an app in a thread may ask for. Kompas's own widgets and plugins are answered here, so
 * they work on every provider and after the agent stopped; other apps still go to their agent.
 */
export class KompasApps extends Context.Service<
  KompasApps,
  McpAppRequests.McpAppRequests["Service"]
>()("t3/kompas/KompasApps") {}

const make = Effect.gen(function* () {
  const agentApps = yield* McpAppRequests.McpAppRequests;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const widgetTools = yield* WidgetTools;
  const widgets = yield* WidgetPublisher;
  const pluginStore = yield* PluginStore;
  const plugins = yield* PluginService;
  const proxy = yield* PluginProxy;

  const fail = (
    threadId: ThreadId,
    reason: McpAppRequestError["reason"] = "request-failed",
    cause?: unknown,
  ) => new McpAppRequestError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });

  const ownerOf = Effect.fn("KompasApps.ownerOf")(function* (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) {
    const item = yield* orchestrator
      .getTurnItem({ threadId: input.threadId, itemId: input.itemId })
      .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
    const app = item?.type === "dynamic_tool" ? mcpAppFromToolItem(item) : undefined;
    if (app?.server === T3_WIDGET_SERVER) {
      const widget = yield* widgets.read(app);
      if (widget === undefined) return yield* fail(input.threadId, "not-an-app");
      return { type: "widget" as const, widget };
    }
    if (app === undefined) return { type: "agent" as const };
    const plugin = yield* pluginStore.forThread(input.threadId).pipe(
      Effect.map((enabled) => enabled.find(({ name }) => name === app.server)),
      Effect.flatMap((found) =>
        found === undefined ? Effect.undefined : plugins.forThread(input.threadId, found.id),
      ),
      Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)),
    );
    return plugin === undefined ? { type: "agent" as const } : { type: "plugin" as const, plugin };
  });

  const pluginTool = Effect.fn("KompasApps.pluginTool")(function* (
    threadId: ThreadId,
    plugin: Parameters<typeof proxy.listAllTools>[0],
    name: string,
  ) {
    const tools = yield* proxy
      .listAllTools(plugin)
      .pipe(Effect.mapError((cause) => fail(threadId, "request-failed", cause)));
    return tools.find((tool) => tool.name === name);
  });

  return KompasApps.of({
    updateModelContext: agentApps.updateModelContext,
    toolInfo: Effect.fn("KompasApps.toolInfo")(function* (input) {
      const owner = yield* ownerOf(input);
      if (owner.type === "agent") return yield* agentApps.toolInfo(input);
      if (owner.type === "widget") {
        const call = widgetCall(owner.widget.name, input.name);
        return { callable: call !== undefined, readOnly: call?.readOnly === true, trusted: true };
      }
      const tool = yield* pluginTool(input.threadId, owner.plugin, input.name);
      return {
        callable: tool !== undefined && mcpAppToolCallableByApp(tool._meta),
        readOnly: tool?.annotations?.readOnlyHint === true,
        ...(tool?.title === undefined ? {} : { title: tool.title }),
        ...(tool === undefined ? {} : { tool }),
      };
    }),
    callTool: Effect.fn("KompasApps.callTool")(function* (input) {
      const owner = yield* ownerOf(input);
      if (owner.type === "agent") return yield* agentApps.callTool(input);
      if (owner.type === "widget") {
        return yield* widgetTools
          .call({
            threadId: input.threadId,
            widget: owner.widget,
            name: input.name,
            arguments: input.arguments,
          })
          .pipe(
            Effect.map((result): McpAppCallToolResult => ({
              content: [{ type: "text", text: "" }],
              structuredContent: result,
            })),
            Effect.catch((error) =>
              Effect.succeed<McpAppCallToolResult>({
                isError: true,
                content: [{ type: "text", text: error.message }],
              }),
            ),
          );
      }
      const tool = yield* pluginTool(input.threadId, owner.plugin, input.name);
      if (tool === undefined || !mcpAppToolCallableByApp(tool._meta)) {
        return yield* fail(input.threadId, "tool-not-callable");
      }
      const result = yield* proxy
        .callToolFromApp(owner.plugin, { name: input.name, arguments: { ...input.arguments } })
        .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
      return {
        content: Array.isArray(result.content) ? result.content : [],
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        ...(result.isError === true ? { isError: true } : {}),
        ...(result._meta === undefined ? {} : { _meta: result._meta }),
      };
    }),
    readResource: Effect.fn("KompasApps.readResource")(function* (input) {
      const owner = yield* ownerOf(input);
      if (owner.type === "agent") return yield* agentApps.readResource(input);
      if (owner.type === "widget") return yield* fail(input.threadId, "unsupported-content");
      const { contents } = yield* proxy
        .readResource(owner.plugin, input.uri)
        .pipe(Effect.mapError((cause) => fail(input.threadId, "request-failed", cause)));
      return { contents };
    }),
  });
});

export const layer = Layer.effect(KompasApps, make);
