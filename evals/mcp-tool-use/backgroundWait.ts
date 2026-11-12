// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3's real `t3_background_wait` handler and ThreadManagementService over a Claude session.
 * Only the adapter is the eval's: like Claude's, it matches task IDs against the session's
 * running background work, which the case lists in `world.backgroundTasks`.
 */
import {
  EnvironmentId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- the eval calls the tool McpHttpServer registered and registers none.
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../apps/server/src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../apps/server/src/mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../apps/server/src/mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../apps/server/src/mcp/OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../apps/server/src/mcp/ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "../../apps/server/src/mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import * as CommandReceiptStore from "../../apps/server/src/orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../apps/server/src/orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../apps/server/src/orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../apps/server/src/peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../apps/server/src/peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../apps/server/src/peer/PeerLinks.ts";
import * as RemoteDelegation from "../../apps/server/src/peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../../apps/server/src/persistence/Sqlite.ts";
import * as ServerSettings from "../../apps/server/src/serverSettings.ts";

const threadId = ThreadId.make("mcp-tool-use-eval");
const providerThreadId = ProviderThreadId.make("provider-thread:mcp-tool-use-eval");
const providerSessionId = ProviderSessionId.make("provider-session:mcp-tool-use-eval");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");

/** Calls T3's `t3_background_wait` with `running` as the session's running background task IDs. */
export const makeBackgroundWait = Effect.fn("evaluateMcpToolUse.makeBackgroundWait")(function* (
  running: ReadonlyArray<string>,
) {
  const now = yield* DateTime.now;
  const providerThread = {
    id: providerThreadId,
    driver,
    providerInstanceId,
    providerSessionId,
    appThreadId: threadId,
    nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
    pendingBackgroundTasks: running.map((taskId) => ({ taskId, kind: "command" })),
    createdAt: now,
    updatedAt: now,
  } as unknown as OrchestrationV2ProviderThread;
  const runtime = {
    driver,
    providerSessionId,
    awaitBackgroundTasks: (input: { readonly taskIds: ReadonlyArray<string> }) =>
      Effect.succeed({ matched: [...new Set(input.taskIds)].filter((id) => running.includes(id)) }),
  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  const real = yield* Layer.build(
    ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              Effect.succeed({
                thread: { id: threadId, deletedAt: null, activeProviderThreadId: providerThreadId },
                providerThreads: [providerThread],
              } as unknown as OrchestrationV2ThreadProjection),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () => Effect.succeedSome(runtime),
          }),
          ServerSettings.layerTest(),
          CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        ),
      ),
    ),
    // The receipt store's in-memory migrations log every step.
  ).pipe(Effect.provideService(References.MinimumLogLevel, "Error"));
  const service = Context.get(real, ThreadManagementService.ThreadManagementService);
  // The caller's thread is live on the Claude instance, mid-turn.
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    ...service,
    getThreadShell: () => Effect.succeed({ ...liveThreadShell(threadId), providerInstanceId }),
  });
  const context = yield* Layer.build(
    McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer).pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
      Layer.provide(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
      Layer.provide(threads),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    ),
  );
  type Entry = Parameters<McpServer.McpServer["Service"]["addTool"]>[0];
  // The registry keeps each tool's handler; its public type lists only definitions.
  const tools = Context.get(context, McpServer.McpServer).tools as ReadonlyArray<Entry>;
  const entry = tools.find((tool) => tool.tool.name === "t3_background_wait");
  if (entry === undefined) return yield* Effect.die(new Error("T3 has no t3_background_wait."));
  const scope: McpInvocationContext.McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("00000000-0000-4000-8000-0000000000e0"),
    requestNamespace: "mcp-tool-use-eval",
    thread: { threadId, providerSessionId: "mcp-tool-use-eval", providerInstanceId },
    client: undefined,
    capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
    issuedAt: 0,
  };
  const request = McpSchema.McpRequestContext.of({
    clientId: 0,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
  });
  return Effect.fn("evaluateMcpToolUse.backgroundWait")(function* (input: unknown) {
    const result = yield* entry.handle(input).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpRequestContext, request),
      // An MCP client shows a protocol error, such as bad parameters, as the tool's error.
      Effect.catch((error) =>
        Effect.succeed(
          new McpSchema.CallToolResult({
            isError: true,
            content: [{ type: "text", text: error.message }],
          }),
        ),
      ),
    );
    if (!("content" in result))
      return yield* Effect.die(new Error("Background wait asked for input."));
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    if (text === "Tool execution failed due to an internal server error.") {
      return yield* Effect.die(new Error("t3_background_wait hit a defect in T3 or the eval."));
    }
    return { text, isError: result.isError === true };
  });
});
export type BackgroundWait = Effect.Success<ReturnType<typeof makeBackgroundWait>>;
