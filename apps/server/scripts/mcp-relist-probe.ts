// Serves T3's real MCP transport with a hidden tool, to see whether a harness lists tools again
// after `tool_search`, before T3 defers tools for it (docs/internals/03_providers.md).
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer takes Node's createServer.
import * as NodeHttp from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { Command, Flag } from "effect/cli";
import { HttpRouter } from "effect/http";

import * as McpHttpServer from "../src/mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../src/mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../src/mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../src/mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../src/mcp/McpToolAccess.testkit.ts";
import * as ServerSettings from "../src/serverSettings.ts";

const token = "probe";
const code = "plum-4471";

const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("probe"),
  requestNamespace: token,
  thread: {
    threadId: ThreadId.make("probe-thread"),
    providerSessionId: token,
    providerInstanceId: ProviderInstanceId.make("probe"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const ProbeToolkit = Toolkit.make(
  Tool.make("delegate_task", {
    description: "Not part of this probe. Do not call.",
    success: Schema.Struct({}),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
  Tool.make("probe_secret", {
    description: "Returns the probe's secret code.",
    success: Schema.Struct({ code: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  })
    // Read-only, so a harness in a no-approval mode still runs it.
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);

const served = McpHttpServer.layerMcpTransport(
  Layer.mergeAll(
    McpHttpServer.toolkitRegistration(
      ProbeToolkit,
      McpToolAccess.toLayer(ProbeToolkit, {
        delegate_task: McpToolAccess.reads(() => Effect.succeed({})),
        probe_secret: McpToolAccess.reads(() =>
          Effect.log("probe: the model called the hidden tool").pipe(Effect.as({ code })),
        ),
      }),
    ),
    McpHttpServer.layerToolSearch,
  ),
).pipe(
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      resolve: (candidate) => Effect.succeed(candidate === token ? scope : undefined),
    }),
  ),
);

const command = Command.make(
  "mcp-relist-probe",
  { port: Flag.Int("port").pipe(Flag.withDefault(8787)) },
  ({ port }) =>
    Console.log(`MCP endpoint: http://127.0.0.1:${port}/mcp
Headers: "Authorization: Bearer ${token}" and "t3-tool-exposure: deferred"
Prompt:  Find the tool that returns the probe's secret code, call it, and reply with the code.
Pass:    a "mcp.tool-search.relisted" line, then "the model called the hidden tool" in one turn.
Restart this server for each run: a search stays loaded for the life of the process.
`).pipe(
      Effect.andThen(
        HttpRouter.serve(served, { disableListenLog: true }).pipe(
          Layer.provide(NodeHttpServer.layer(NodeHttp.createServer, { port, host: "127.0.0.1" })),
          Layer.provide(Logger.layer([Logger.consolePretty()])),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Debug")),
          Layer.launch,
        ),
      ),
    ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
