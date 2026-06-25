import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(McpHttpServer.OrchestrationToolkitRegistrationLive),
  Layer.provideMerge(McpHttpServer.TerminalToolkitRegistrationLive),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const requests = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
        threadId,
        tabId,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-11T00:00:00.000Z",
      });
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          requestId: request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationExecutionError",
            message: "sensitive renderer failure",
            detail: { consoleOutput: "sensitive browser output" },
          },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.reportOwner({
        clientId: "mcp-failure-client",
        environmentId,
        threadId,
        tabId,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-11T00:00:00.000Z",
      });

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const requests = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
        threadId,
        tabId,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-11T00:00:00.000Z",
      });
      yield* Stream.runForEach(requests, (request) =>
        broker.respond({
          requestId: request.requestId,
          ok: true,
          result:
            request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.reportOwner({
        clientId: "mcp-test-client",
        environmentId,
        threadId,
        tabId,
        visible: true,
        supportsAutomation: true,
        focusedAt: "2026-06-11T00:00:00.000Z",
      });

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const browserOpenTool = server.tools.find(({ tool }) => tool.name === "browser_open");
      expect(browserOpenTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(browserOpenTool?.tool.annotations?.openWorldHint).toBe(true);

      const browserOpen = yield* server
        .callTool({ name: "browser_open", arguments: { url: "http://example.test/" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(browserOpen.isError).toBe(false);
      expect(browserOpen.structuredContent).toMatchObject({
        available: true,
        tabId,
        url: "http://example.test/",
      });

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(malformed.isError).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("registers orchestration and terminal tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const now = "2026-06-11T00:00:00.000Z";
      const projectShell: OrchestrationProjectShell = {
        id: ProjectId.make("project-mcp-test"),
        title: "MCP Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
        scripts: [],
        createdAt: now,
        updatedAt: now,
      };
      const baseThreadShell = (
        overrides: Partial<OrchestrationThreadShell> = {},
      ): OrchestrationThreadShell => ({
        id: ThreadId.make("thread-mcp-base"),
        projectId: projectShell.id,
        title: "Base thread",
        modelSelection:
          projectShell.defaultModelSelection ??
          ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        ...overrides,
      });
      let threads: OrchestrationThreadShell[] = [baseThreadShell()];
      let dispatchSequence = 0;
      let openedTerminalInput: unknown = null;
      let terminalWrites: string[] = [];
      const terminalSnapshot: TerminalSessionSnapshot = {
        threadId: threadId,
        terminalId: "term-1",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running",
        pid: 12345,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "zsh",
        updatedAt: now,
        sequence: 1,
      };
      const snapshotQuery = ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [projectShell],
            threads,
            updatedAt: now,
          }),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
        getProjectShellById: (projectId) =>
          Effect.succeed(projectId === projectShell.id ? Option.some(projectShell) : Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.die("unused"),
        getFullThreadDiffContext: () => Effect.die("unused"),
        getThreadShellById: (threadId) => {
          const thread = threads.find((entry) => entry.id === threadId);
          return Effect.succeed(thread === undefined ? Option.none() : Option.some(thread));
        },
        getThreadDetailById: () => Effect.die("unused"),
      });
      const orchestrationEngine = OrchestrationEngine.OrchestrationEngineService.of({
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatchSequence += 1;
            if (command.type === "thread.create") {
              const createdThread = baseThreadShell({
                id: command.threadId,
                projectId: command.projectId,
                title: command.title,
                modelSelection:
                  command.modelSelection ??
                  projectShell.defaultModelSelection ??
                  ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
                runtimeMode: command.runtimeMode,
                interactionMode: command.interactionMode,
                branch: command.branch,
                worktreePath: command.worktreePath,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              });
              threads = [
                ...threads.filter((thread) => thread.id !== command.threadId),
                createdThread,
              ];
            }
            if (command.type === "thread.archive") {
              threads = threads.map((thread) =>
                thread.id === command.threadId
                  ? { ...thread, archivedAt: now, updatedAt: now }
                  : thread,
              );
            }
            return { sequence: dispatchSequence };
          }),
        streamDomainEvents: Stream.empty,
      });
      const terminalManager = TerminalManager.TerminalManager.of({
        open: (input) =>
          Effect.sync(() => {
            openedTerminalInput = input;
            return terminalSnapshot;
          }),
        attachStream: () => Effect.die("unused"),
        write: (input) =>
          Effect.sync(() => {
            terminalWrites.push(input.data);
          }),
        resize: () => Effect.void,
        clear: () => Effect.void,
        restart: () => Effect.die("unused"),
        close: () => Effect.void,
        subscribe: () => Effect.succeed(() => undefined),
        subscribeMetadata: () => Effect.succeed(() => undefined),
      });

      const callTool = <TArguments extends Record<string, unknown>>(
        name: string,
        args: TArguments,
      ) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
            Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshotQuery),
            Effect.provideService(
              OrchestrationEngine.OrchestrationEngineService,
              orchestrationEngine,
            ),
            Effect.provideService(TerminalManager.TerminalManager, terminalManager),
          );

      const projectsList = yield* callTool("projects_list", {});
      expect(projectsList.isError).toBe(false);
      expect(projectsList.structuredContent).toMatchObject({ projects: [projectShell] });

      const threadsList = yield* callTool("threads_list", { projectId: projectShell.id });
      expect(threadsList.isError).toBe(false);
      expect(threadsList.structuredContent).toMatchObject({ threads });

      const createdThread = yield* callTool("threads_create", {
        projectId: projectShell.id,
        title: "Investigate bug",
      });
      expect(createdThread.isError).toBe(false);
      expect(createdThread.structuredContent).toMatchObject({
        thread: {
          projectId: projectShell.id,
          title: "Investigate bug",
        },
      });

      const archivedThreadId = threads[0]!.id;
      const archivedThread = yield* callTool("threads_archive", {
        threadId: archivedThreadId,
      });
      expect(archivedThread.isError).toBe(false);
      expect(archivedThread.structuredContent).toMatchObject({
        thread: {
          id: archivedThreadId,
          archivedAt: now,
        },
      });

      const terminalRun = yield* callTool("terminal_run", {
        cwd: "/tmp/project",
        command: "echo hello",
      });
      expect(terminalRun.isError).toBe(false);
      expect(terminalRun.structuredContent).toMatchObject({
        terminalId: "term-1",
        cwd: "/tmp/project",
      });
      expect(openedTerminalInput).toMatchObject({
        threadId,
        terminalId: "term-1",
        cwd: "/tmp/project",
      });
      expect(terminalWrites).toEqual(["echo hello\n"]);

      const orchestrationTool = server.tools.find(({ tool }) => tool.name === "threads_create");
      expect(orchestrationTool?.tool.annotations?.destructiveHint).toBe(true);
      const terminalTool = server.tools.find(({ tool }) => tool.name === "terminal_run");
      expect(terminalTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(terminalTool?.tool.annotations?.openWorldHint).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
