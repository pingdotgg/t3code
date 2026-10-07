import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PluginInstallationId,
  PluginToolError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as PluginTools from "../../../plugins/PluginTools.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const grants = [{ installationId: PluginInstallationId.make("installation-1"), generation: 3 }];
const invocation = {
  environmentId: EnvironmentId.make("environment-plugin-tools"),
  capabilities: new Set(),
  issuedAt: 1,
  requestNamespace: "thread:thread-plugin-tools",
  thread: {
    threadId: ThreadId.make("thread-plugin-tools"),
    providerSessionId: "provider-session-plugin-tools",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  pluginToolGrants: grants,
} satisfies McpInvocationContext.McpInvocationScope;
// An MCP OAuth client signed in from outside T3 Code: no thread and no grants.
const outsideClient = {
  environmentId: invocation.environmentId,
  capabilities: new Set(),
  issuedAt: 1,
  requestNamespace: "client:session-outside",
  thread: undefined,
  client: { sessionId: "session-outside", label: "outside", access: "full-access" },
} satisfies McpInvocationContext.McpInvocationScope;
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "takes grants and thread from the credential and marks the call tool conservatively",
  () => {
    const seen: Array<unknown> = [];
    const tools = Layer.mock(PluginTools.PluginTools)({
      list: (granted, options) =>
        Effect.sync(() => {
          seen.push({ granted, options });
          return { tools: [], notInThisSession: [] };
        }),
      call: (granted, request) =>
        Effect.suspend(() => {
          seen.push({ granted, request });
          return request.tool === "acme.search/lookup"
            ? Effect.succeed({ hits: 1 })
            : Effect.fail(
                new PluginToolError({ reason: "unknown-tool", message: "No such tool." }),
              );
        }),
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const registered = Object.fromEntries(server.tools.map(({ tool }) => [tool.name, tool]));
      expect(registered.plugin_tools_list?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(registered.plugin_tool_call?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
      const callTool = (
        name: string,
        args: Record<string, unknown>,
        scope: McpInvocationContext.McpInvocationScope = invocation,
      ) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

      const listed = yield* callTool("plugin_tools_list", { plugin: "acme.search", cursor: "a" });
      expect(listed.isError).toBe(false);
      // A context the agent passes is only input; the plugin gets the credential's.
      const called = yield* callTool("plugin_tool_call", {
        tool: "acme.search/lookup",
        input: { q: "x", context: { threadId: "spoofed" } },
      });
      expect(called).toMatchObject({ isError: false, structuredContent: { result: { hits: 1 } } });
      const failed = yield* callTool("plugin_tool_call", { tool: "acme.search/nope" });
      expect(failed.isError).toBe(true);
      expect(failed.content).toEqual([{ type: "text", text: "No such tool." }]);

      expect(seen).toEqual([
        { granted: grants, options: { plugin: "acme.search", cursor: "a" } },
        {
          granted: grants,
          request: {
            tool: "acme.search/lookup",
            input: { q: "x", context: { threadId: "spoofed" } },
            context: {
              environmentId: invocation.environmentId,
              threadId: invocation.thread.threadId,
            },
          },
        },
        {
          granted: grants,
          request: {
            tool: "acme.search/nope",
            input: {},
            context: {
              environmentId: invocation.environmentId,
              threadId: invocation.thread.threadId,
            },
          },
        },
      ]);

      // Outside clients see no plugin tools and cannot call one; the plugin is never reached.
      seen.length = 0;
      const outsideList = yield* callTool("plugin_tools_list", {}, outsideClient);
      expect(outsideList.isError).toBe(false);
      const outsideCall = yield* callTool(
        "plugin_tool_call",
        { tool: "acme.search/lookup" },
        outsideClient,
      );
      expect(outsideCall.isError).toBe(true);
      expect(outsideCall.content).toEqual([
        {
          type: "text",
          text: "This tool acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.",
        },
      ]);
      expect(seen).toEqual([{ granted: [], options: {} }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        McpHttpServer.layerPluginToolsToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(tools),
          Layer.provide(liveThreadsLayer),
        ),
      ),
    );
  },
);
