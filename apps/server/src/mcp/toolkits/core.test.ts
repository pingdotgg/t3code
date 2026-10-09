import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import {
  DEFAULT_SERVER_SETTINGS,
  ChatImageAttachment,
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpAttachmentInput } from "./attachment/input.ts";
import { McpSchema, McpServer, Tool } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import { dispatchFailure } from "../threadAccess.ts";
import { OrchestratorToolkit } from "./orchestrator/tools.ts";
import { PreviewToolkit } from "./preview/tools.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import * as EnvironmentHandlers from "./environment/handlers.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import * as AttachmentHandlers from "./attachment/handlers.ts";
import { ThreadToolkit } from "./thread/tools.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";
import { DeviceToolkit } from "./device/tools.ts";

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
import { PullRequestsToolkit } from "./pullRequests/tools.ts";
import { HtmlToolkit } from "./html/tools.ts";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
  resolveT3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";

const decodeMcpAttachmentInput = Schema.decodeUnknownEffect(McpAttachmentInput);

it("publishes unique tool names with reference-free object-root inputs", () => {
  const names = new Set<string>();
  for (const toolkit of [
    OrchestratorToolkit,
    PreviewToolkit,
    WorktreeToolkit,
    ThreadToolkit,
    AttachmentToolkit,
    ProjectToolkit,
    EnvironmentToolkit,
    PreviewControlsToolkit,
    DeviceToolkit,
    PullRequestsToolkit,
    HtmlToolkit,
  ]) {
    for (const tool of Object.values(toolkit.tools)) {
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
      const schema = Tool.getJsonSchema(tool);
      expect(schema).toMatchObject({ type: "object" });
      // The published tool catalog must also work with providers without $ref support.
      expect(JSON.stringify(schema), tool.name).not.toContain('"$ref"');
      // Every published tool must have labels for its lifecycle, branding, and a summary.
      const definition = resolveT3McpToolDefinition(tool.name);
      expect(definition, tool.name).not.toBeNull();
      expect(
        definition?.labels.every((label) => label.trim().length > 0),
        tool.name,
      ).toBe(true);
      for (const name of [tool.name, `mcp__t3-code__${tool.name}`, `T3-code.${tool.name}`]) {
        expect(resolveT3McpToolPresentation(name)?.logo, name).toBe("t3-code");
        expect(resolveT3McpToolSummaryAction(name), name).not.toBeNull();
      }
    }
  }
  expect(names.has("t3_thread_launch")).toBe(true);
  expect(names.has("t3_thread_start")).toBe(false);
});

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "mcp-core-session",
  thread: {
    threadId,
    providerSessionId: "mcp-core-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("checks capability through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.some(({ tool }) => tool.name === "t3_thread_organize")).toBe(true);
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities: new Set<never>(),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
      ),
    ),
  ),
);

it.effect("returns a bounded public failure without serializing storage causes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toEqual({
      _tag: "OrchestratorMcpFailure",
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: '{"_tag":"OrchestratorMcpFailure","code":"orchestration_error","message":"The operation could not be completed."}',
      },
    ]);
    const definition = server.tools.find(({ tool }) => tool.name === "t3_thread_organize");
    expect(definition?.tool.outputSchema).toBeDefined();
    const validate = new AjvJsonSchemaValidator().getValidator(
      definition!.tool.outputSchema! as JsonSchemaType,
    );
    expect(result.structuredContent).toBeUndefined();
    expect(validate({ sequence: 1 }).valid).toBe(true);
    expect(validate({ code: "orchestration_error" }).valid).toBe(false);
    expect(validate({ sequence: "invalid" }).valid).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.fail(
                new OrchestratorProjectionError({
                  threadId,
                  cause: new Error("private-storage-path"),
                }),
              ),
          }),
        ),
      ),
    ),
  ),
);

it("bounds public command rejections and redacts internal dispatch causes", () => {
  const command = { commandId: CommandId.make("mcp-core-command"), commandType: "thread.settle" };
  expect(
    dispatchFailure(new OrchestratorDispatchError({ ...command, cause: "🙂".repeat(1001) }))
      .message,
  ).toBe("🙂".repeat(1000));
  expect(
    dispatchFailure(
      new OrchestratorCommandRejectedError({ ...command, cause: "Run is not queued." }),
    ).message,
  ).toBe("Run is not queued.");
  for (const cause of [
    undefined,
    "",
    new Error("private-storage-path"),
    { message: "private-storage-path" },
  ]) {
    expect(dispatchFailure(new OrchestratorDispatchError({ ...command, cause }))).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
    expect(
      dispatchFailure(new OrchestratorCommandRejectedError({ ...command, cause })),
    ).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }
  expect(
    dispatchFailure(new OrchestratorProjectionError({ threadId, cause: "private-storage-path" })),
  ).toMatchObject({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });
});

it.effect("returns an HTML render reference that Codex and Claude tool rows both carry", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "html_render",
        arguments: { html: "<p>Revenue</p>", title: "Revenue", height: 240 },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const reference = htmlRenderFromToolItem({
      toolName: "t3-code.html_render",
      output: result.structuredContent,
    });
    expect(reference).toMatchObject({ title: "Revenue", height: 240 });
    expect(
      htmlRenderFromToolItem({ toolName: "mcp__t3-code__html_render", output: result.content }),
    ).toEqual(reference);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerHtmlToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-html-render-" })),
        Layer.provide(NodeServices.layer),
        // The preview browser is not installed in a fresh home, so nothing downloads.
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            // A live run: publishing stores a page, so it needs the caller's active turn.
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                deletedAt: null,
                archivedAt: null,
                activeRunId: RunId.make("mcp-core-run"),
                providerInstanceId: ProviderInstanceId.make("codex"),
              } as OrchestrationV2ThreadShell),
          }),
        ),
      ),
    ),
  ),
);

it.effect("returns invalid parameter errors through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const error = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "invalid" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.flip,
      );
    expect(error._tag).toBe("InvalidParams");
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      ),
    ),
  ),
);

it.effect("keeps unexpected handler defects private through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "Tool execution failed due to an internal server error." },
    ]);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.die(new Error("private-storage-path")),
          }),
        ),
      ),
    ),
  ),
);

it("keeps MCP preference output allowlisted and Unicode-bounded", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    privateCredential: "must-not-escape",
    sourceControlWritingStyle: {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      customInstructions: "🙂".repeat(4001),
    },
  };
  const result = EnvironmentHandlers.preferences(settings);
  expect(result).not.toHaveProperty("privateCredential");
  expect(result).not.toHaveProperty("providers");
  expect(result.sourceControlWritingStyle).toMatchObject({
    customInstructions: "🙂".repeat(4000),
    truncated: true,
  });
});

it.effect("resolves reused attachment references from stored metadata", () =>
  Effect.gen(function* () {
    const stored = ChatImageAttachment.make({
      type: "image",
      id: "owned-image",
      name: "original.png",
      mimeType: "image/png",
      sizeBytes: 12,
      source: {
        kind: "snap-shot",
        capturedAt: "2026-09-10T00:00:00.000Z",
        appName: "Terminal",
        windowTitle: "Test",
        accessibility: { format: "flat-text", text: "Stored context", truncated: false },
      },
    });
    const forged = yield* decodeMcpAttachmentInput({
      type: "image",
      id: stored.id,
      name: "changed.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 99,
    });
    const result = yield* AttachmentHandlers.resolveAttachmentReferences([forged], [stored]);
    expect(result).toEqual([stored]);
    const failure = yield* AttachmentHandlers.resolveAttachmentReferences(
      [{ ...forged, id: "other-image" }],
      [stored],
    ).pipe(Effect.flip);
    expect(failure.code).toBe("invalid_request");
  }),
);

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
});

it.effect("a client caller targets any thread within its ceiling and cannot act as a thread", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const untargeted = yield* call("t3_thread_organize", { action: "pin" }, clientScope("auto"));
    expect(declaredFailure(untargeted)).toMatchObject({ code: "target_required" });

    const pinned = yield* call(
      "t3_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("auto"),
    );
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toMatchObject({ sequence: 7 });

    const aboveCeiling = yield* call(
      "t3_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("approval-required"),
    );
    expect(declaredFailure(aboveCeiling)).toMatchObject({
      code: "runtime_mode_escalation_denied",
    });

    const forked = yield* call(
      "t3_thread_fork",
      { sourcePoint: { type: "latest_stable" } },
      clientScope("auto"),
    );
    expect(declaredFailure(forked)).toMatchObject({ code: "target_required" });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () => Effect.succeed({ sequence: 7, storedEvents: [] }),
          }),
        ),
      ),
    ),
  ),
);

it.effect("a read-only client reads threads and is refused every write before it runs", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            clientScope("read-only"),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const configuration = yield* call("t3_thread_configuration", {
      threadId: "other-project-thread",
    });
    expect(configuration.isError).toBe(false);
    expect(configuration.structuredContent).toMatchObject({ runtimeMode: "auto" });

    const pinned = yield* call("t3_thread_organize", {
      action: "pin",
      threadId: "other-project-thread",
    });
    expect(declaredFailure(pinned)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);

    const configure = yield* call("t3_thread_configure", {
      threadId: "other-project-thread",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
    });
    expect(declaredFailure(configure)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: ThreadId.make("other-project-thread"),
                projectId: "other-project",
                deletedAt: null,
              } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  modelSelection: { instanceId: "codex", model: "gpt-5" },
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () =>
              Effect.sync(() => {
                dispatched.push("dispatch");
                return { sequence: 7 } as never;
              }),
          }),
        ),
      ),
    ),
  ),
);
const dispatched: Array<string> = [];

it.effect("refuses act-as-caller tools to a client caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "delegate_task",
        arguments: { task: "Review", mode: "async" },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "thread_credential_required" });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

it.effect("a caller cannot rewrite a scheduled task that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const update = yield* call("update_scheduled_task", {
      scheduledTaskId: "task-full-access",
      prompt: "Run something else",
    });
    expect(declaredFailure(update)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const remove = yield* call("delete_scheduled_task", { scheduledTaskId: "task-full-access" });
    expect(declaredFailure(remove)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const allowed = yield* call("update_scheduled_task", {
      scheduledTaskId: "task-auto",
      enabled: false,
    });
    expect(allowed.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [
                  scheduledTask("task-full-access", "full-access"),
                  scheduledTask("task-auto", "auto"),
                ],
              }),
            upsert: (input) =>
              Effect.succeed({
                task: { ...(scheduledTask(input.id ?? "task-auto", "auto") as object), ...input },
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

function scheduledTask(id: string, runtimeMode: "auto" | "full-access"): never {
  return {
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as never;
}

it.effect("a caller cannot interrupt a thread that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_interrupt", arguments: { threadId: "full-access-thread" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "runtime_mode_escalation_denied" });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ projectId: "project-a", deletedAt: null } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("full-access-thread"),
                  projectId: "project-a",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  deletedAt: null,
                },
                runs: [],
              } as never),
            interruptThread: () => Effect.die("interrupt must not dispatch above the ceiling"),
          }),
        ),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

it.effect("only the caller that prepared a pending upload can discard it", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const prepared = yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "shot.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );
    const { attachmentId } = prepared.structuredContent as { readonly attachmentId: string };
    const otherThread = {
      ...scope,
      requestNamespace: "other-session",
      thread: { ...scope.thread!, threadId: ThreadId.make("other-thread") },
    };

    const refused = yield* call("t3_attachment_discard", { attachmentId }, otherThread);
    expect(declaredFailure(refused)).toMatchObject({ code: "invalid_request" });

    // Another prepare a day later keeps it: the file outlives its URL's 24 hours
    // by as long as the upload took, up to the URL's own lifetime.
    yield* TestClock.adjust(24 * 60 * 60 * 1000 + 5 * 60_000);
    yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "later.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );

    // A new provider session of the same thread still owns the upload.
    const discarded = yield* call(
      "t3_attachment_discard",
      { attachmentId },
      { ...scope, requestNamespace: "mcp-core-session-2" },
    );
    expect(discarded.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAttachmentToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-attachment-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
