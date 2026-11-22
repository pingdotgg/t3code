import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { McpSchema, McpServer } from "effect/ai";

import * as ElectronicsService from "../electronics/ElectronicsService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const testClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-electronics-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-electronics-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const makeMcpTestLayer = (
  workspaceRoot: string,
  settingsOverride: Partial<typeof DEFAULT_SERVER_SETTINGS> = {},
) => {
  const mockSettings = ServerSettings.layerTest(settingsOverride);
  const mockSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.fail(new Error("ENOENT") as never)),
  );
  const mockThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        id: ThreadId.make("thread-mcp-elec"),
        projectId: ProjectId.make("proj-mcp-elec"),
        worktreePath: workspaceRoot,
        deletedAt: null,
        archivedAt: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        linkOrigin: null,
        activeRunId: "run-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        pendingBackgroundTasks: [],
      } as never),
  });
  const mockProjects = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedSome({ workspaceRoot } as never),
  });
  const electronicsLayer = ElectronicsService.layer.pipe(
    Layer.provide(mockSettings),
    Layer.provide(mockSpawner),
    Layer.provide(NodeServices.layer),
  );
  return McpHttpServer.layerElectronicsToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(electronicsLayer),
    Layer.provide(mockThreads),
    Layer.provide(mockProjects),
    Layer.provide(mockSettings),
    Layer.provideMerge(NodeServices.layer),
  );
};

const scopeForThread = (): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-test"),
  requestNamespace: "provider-session-elec-test",
  capabilities: new Set(),
  client: undefined,
  issuedAt: 1,
  thread: {
    threadId: ThreadId.make("thread-mcp-elec"),
    providerSessionId: "sess-1",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
});

it.effect(
  "runs electronics MCP tools end-to-end: list, open, inspect, trace_path, validate, simulate",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-elec-" });
      yield* fs.writeFileString(
        path.join(dir, "rc.cir"),
        "* RC Filter\nV1 vin 0 DC 5 AC 1\nR1 vin vout 1k\nC1 vout 0 100n\n.end\n",
      );

      yield* Effect.gen(function* () {
        const mcp = yield* McpServer.McpServer;
        const callTool = (name: string, args: Record<string, unknown>) =>
          mcp
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scopeForThread()),
              Effect.provideService(McpSchema.McpServerClient, testClient),
            );

        const textOf = (res: McpSchema.CallToolResult) =>
          res.content
            .map((item) => (item.type === "text" ? item.text : JSON.stringify(item)))
            .join("\n");

        const listRes = yield* callTool("electronics_list", {});
        expect(listRes.isError).toBe(false);
        expect(textOf(listRes)).toContain("rc.cir");

        const openRes = yield* callTool("electronics_open", {
          filePath: "rc.cir",
          activeTab: "canvas",
        });
        expect(openRes.isError).toBe(false);
        expect(textOf(openRes)).toContain("spice");

        const inspectRes = yield* callTool("electronics_inspect", { filePath: "rc.cir" });
        expect(inspectRes.isError).toBe(false);
        expect(textOf(inspectRes)).toContain("R1");

        const traceRes = yield* callTool("electronics_trace_path", {
          filePath: "rc.cir",
          from: "V1.+",
          to: "vout",
        });
        expect(traceRes.isError).toBe(false);
        expect(textOf(traceRes)).toContain("1000");

        const valRes = yield* callTool("electronics_validate", { filePath: "rc.cir" });
        expect(valRes.isError).toBe(false);
        expect(textOf(valRes)).toContain('"passed":true');

        const simRes = yield* callTool("electronics_simulate", {
          filePath: "rc.cir",
          kind: "ac_sweep",
          outputNode: "vout",
        });
        expect(simRes.isError).toBe(false);
        expect(textOf(simRes)).toContain("-3 dB Cutoff");
      }).pipe(Effect.provide(makeMcpTestLayer(dir)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("blocks electronics MCP tools when enableAgentElectronicsAccess is false", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-elec-off-" });
    yield* Effect.gen(function* () {
      const mcp = yield* McpServer.McpServer;
      const res = yield* mcp
        .callTool({ name: "electronics_list", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scopeForThread()),
          Effect.provideService(McpSchema.McpServerClient, testClient),
        );
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain("turned off");
    }).pipe(Effect.provide(makeMcpTestLayer(dir, { enableAgentElectronicsAccess: false })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
