import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

// A Supervised outside agent renames a thread through a `writesThreads` tool.
// The thread's user raises it to full access after the tool's check but
// before its write: the race the orchestrator closes under the thread's lock.

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "mcp-mode-race" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const RenameTool = Tool.make("rename", {
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({ renamed: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
});
const RenameToolkit = Toolkit.make(RenameTool);

const supervisedClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:race",
  thread: undefined,
  client: { sessionId: "race", label: "Claude Code", runtimeModeCeiling: "approval-required" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-race", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-race", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ renamed: Schema.Boolean }),
      Schema.Struct({ code: Schema.String }),
    ]),
  ),
);

/** Renames `threadId` as the Supervised client; the user may raise it in between. */
const renameRacingTheUser = (threadId: ThreadId, userRaises: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const raised = yield* Ref.make(false);
    const handlers = McpToolAccess.toLayer(RenameToolkit, {
      rename: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            // The tool's own check has passed; the user acts before the write.
            if (userRaises) {
              // The user's own command carries no limit, so it lands.
              yield* orchestrator
                .dispatch({
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make("user-raise"),
                  threadId: input.threadId,
                  runtimeMode: "full-access",
                })
                .pipe(Effect.provideService(DispatchModeLimit, undefined), Effect.orDie);
              yield* Ref.set(raised, true);
            }
            yield* threads
              .dispatch({
                type: "thread.metadata.update",
                commandId: CommandId.make(`agent-rename:${userRaises}`),
                threadId: input.threadId,
                title: "Renamed by the agent",
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "The rename failed.",
                    }),
                ),
              );
            return { renamed: true };
          }),
      ),
    });
    const outcome = yield* McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name: "rename", arguments: { threadId } })),
      Effect.flatMap(({ content }) =>
        decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, supervisedClient),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provide(
        McpHttpServer.toolkitRegistration(RenameToolkit, handlers).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    );
    assert.equal(yield* Ref.get(raised), userRaises);
    return outcome;
  });

const createSupervisedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:mcp-race"),
      title: "Before",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerOrchestrator)("writesThreads against a mode raise", (it) => {
  it.effect("refuses the write when the user raises the thread after the check", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:race-raised");
      yield* createSupervisedThread(threadId);
      const outcome = yield* renameRacingTheUser(threadId, true);
      assert.deepEqual(outcome, { code: "runtime_mode_escalation_denied" });
      const shell = yield* projections.getThreadShell(threadId);
      assert.equal(shell?.runtimeMode, "full-access");
      assert.equal(shell?.title, "Before");
    }).pipe(Effect.provide(ThreadManagement.layer)),
  );

  it.effect("lets the write through when the thread stays within the caller's modes", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:race-steady");
      yield* createSupervisedThread(threadId);
      const outcome = yield* renameRacingTheUser(threadId, false);
      assert.deepEqual(outcome, { renamed: true });
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "Renamed by the agent");
    }).pipe(Effect.provide(ThreadManagement.layer)),
  );
});
