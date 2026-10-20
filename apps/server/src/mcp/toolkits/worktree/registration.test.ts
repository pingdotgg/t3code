import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerConfig from "../../../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ReviewService from "../../../review/ReviewService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../../../workspace/KnownWorkspaces.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import * as WorktreeHandlers from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

it.effect("production mcp layer lists worktree tools over http", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      yield* HttpRouter.serve(layerRoutes, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-scratch" as never),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(layerStubServices),
        Layer.build,
      );

      const registry = McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const credential = yield* registry;
      expect(credential).toBeDefined();

      const httpClient = yield* HttpClient.HttpClient;
      const auth = credential!.config.authorizationHeader;
      const initResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers["mcp-session-id"];

      const listResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: auth,
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          "application/json",
        ),
      });
      const bodyText = yield* listResponse.text;
      const payload = yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0]);
      const tools = payload.result.tools;
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("t3_worktree_handoff");
      expect(toolNames).toContain("t3_worktree_status");
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("delegate_task");

      const handoff = tools.find((tool) => tool.name === "t3_worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find((tool) => tool.name === "t3_worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);

      // MCP requires every tool input schema to be a top-level object schema.
      // A non-object schema (e.g. the anyOf produced by an empty
      // Schema.Struct({})) makes clients reject the entire server.
      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-mcp-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("reads another thread checkout with selected and bounded diff sources", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-diff-" });
    const serverCwd = `${root}/server`;
    const cwd = `${root}/project`;
    const checkout = `${cwd}/checkout`;
    yield* fs.makeDirectory(serverCwd);
    yield* fs.makeDirectory(cwd);
    const targetId = ThreadId.make("thread:diff-target");
    const shell = {
      ...McpToolAccessTestkit.liveThreadShell(targetId),
      projectId: ProjectId.make("project:diff"),
      worktreePath: checkout,
    };
    const config = ServerConfig.layerTest(serverCwd, `${root}/state`);
    const gitLayer = GitVcsDriver.layer.pipe(
      Layer.provide(config),
      Layer.provide(NodeServices.layer),
    );
    const dependencies = Layer.mergeAll(
      ReviewService.layer.pipe(
        Layer.provide(KnownWorkspaces.layer),
        Layer.provide(VcsDriverRegistry.layer),
        Layer.provide(VcsProcess.layer),
        Layer.provide(gitLayer),
        Layer.provide(config),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () =>
              Effect.succeed([
                {
                  id: shell.projectId,
                  title: "Diff",
                  workspaceRoot: cwd,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ]),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(id === targetId ? shell : McpToolAccessTestkit.liveThreadShell(id)),
        getProjectThreadRecords: () =>
          Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeed(
            Option.some({
              id: shell.projectId,
              title: "Diff",
              workspaceRoot: cwd,
              deletedAt: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
          ),
      }),
      Layer.mock(GitWorkflowService.GitWorkflowService)({}),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
      ServerSettings.layerTest(),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment:diff"),
        requestNamespace: "diff-session",
        thread: {
          threadId: ThreadId.make("thread:diff-caller"),
          providerSessionId: "diff-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const, "worktree" as const]),
      }),
    );
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(gitLayer));
    const run = (at: string, args: ReadonlyArray<string>) =>
      git.execute({ cwd: at, args, operation: "mcp-diff-test" });
    yield* run(cwd, ["init", "-b", "main"]);
    yield* run(cwd, ["config", "user.name", "Test"]);
    yield* run(cwd, ["config", "user.email", "test@example.com"]);
    yield* fs.writeFileString(`${cwd}/file.txt`, "original\n");
    yield* run(cwd, ["add", "file.txt"]);
    yield* run(cwd, ["commit", "-m", "base"]);
    yield* run(cwd, ["worktree", "add", "-b", "feature", checkout]);
    yield* fs.writeFileString(`${checkout}/file.txt`, "committed change\n");
    yield* run(checkout, ["commit", "-am", "feature"]);
    yield* fs.writeFileString(`${checkout}/file.txt`, "working change\n");

    yield* Effect.gen(function* () {
      const toolkit = yield* WorktreeToolkit;
      const read = (
        input: {
          source?: "working-tree" | "branch-range";
          baseRef?: string;
          maxCharacters?: number;
        } = {},
      ) =>
        toolkit.handle("t3_thread_diff", { threadId: targetId, baseRef: "main", ...input }).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((chunks) => chunks.at(-1)!.result),
        );
      const all = yield* read();
      expect(all).toMatchObject({ threadId: targetId, cwd: checkout });
      if (!("sources" in all)) throw new Error("Expected a diff result");
      expect(all.sources.map((source) => source.kind)).toEqual(["working-tree", "branch-range"]);
      const working = all.sources[0]!;
      const branch = all.sources[1]!;
      expect(working.diff).toContain("+working change");
      expect(working.diff).toContain("-committed change");
      expect(branch.diff).toContain("+working change");
      expect(branch.diff).toContain("-original");
      expect(branch.diff).not.toContain("-committed change");
      expect(working.files).toEqual([expect.objectContaining({ additions: 1, deletions: 1 })]);
      expect(working.truncated).toBe(false);
      expect(branch.truncated).toBe(false);
      expect(yield* read({ source: "working-tree" })).toEqual({ ...all, sources: [working] });
      expect(yield* read({ source: "working-tree", baseRef: "missing-base" })).toEqual({
        ...all,
        sources: [working],
      });
      expect(yield* read({ baseRef: "missing-base" })).toMatchObject({
        code: "invalid_request",
        message: "Could not find a common commit between 'missing-base' and HEAD.",
      });
      expect(yield* read({ source: "branch-range", baseRef: "missing-base" })).toMatchObject({
        code: "invalid_request",
        message: "Could not find a common commit between 'missing-base' and HEAD.",
      });
      expect(yield* read({ source: "branch-range" })).toEqual({ ...all, sources: [branch] });
      expect(yield* read({ source: "branch-range", maxCharacters: 24 })).toEqual({
        ...all,
        sources: [{ ...branch, diff: branch.diff.slice(0, 24), truncated: true }],
      });
      yield* Effect.forEach(
        Array.from({ length: 500 }, (_, index) => index),
        (index) => fs.writeFileString(`${checkout}/extra-${index}.txt`, "extra\n"),
      );
      const capped = yield* read({ source: "working-tree", maxCharacters: 100_000 });
      if (!("sources" in capped)) throw new Error("Expected a diff result");
      expect(capped.sources[0]!.files).toHaveLength(500);
      expect(capped.sources[0]!.diff.length).toBeLessThan(100_000);
      expect(capped.sources[0]!.truncated).toBe(true);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(WorktreeHandlers.layer).pipe(
          Layer.provideMerge(WorktreeMcpService.layer.pipe(Layer.provide(dependencies))),
          Layer.provideMerge(dependencies),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
