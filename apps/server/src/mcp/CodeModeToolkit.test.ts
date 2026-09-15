import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CodeModeExecutionResult,
  EventId,
  MessageId,
  type OrchestrationV2StoredEvent,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import {
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as CodeModeService from "./CodeModeService.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import * as RegistryTestkit from "./McpSessionRegistry.testkit.ts";
import { OrchestratorMcpService } from "./OrchestratorMcpService.ts";
import { ThreadMetadataMcpService } from "./ThreadMetadataMcpService.ts";
import {
  CodeModeToolkit,
  CodeModeHandlersLive,
  CodeModeDispatchLive,
} from "./toolkits/codeMode.ts";
import { OrchestratorToolkitHandlersLive } from "./toolkits/orchestrator/handlers.ts";
import { ThreadToolkitHandlersLive } from "./toolkits/thread/handlers.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("code-mode-environment"),
  threadId: ThreadId.make("code-mode-parent"),
  providerSessionId: "code-mode-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const projectId = ProjectId.make("code-mode-project");
const runId = RunId.make("code-mode-turn");
const now = DateTime.makeUnsafe("2026-09-14T12:00:00Z");
function shell(activeRunId: RunId | null = runId): OrchestrationV2ThreadShell {
  return {
    id: scope.threadId,
    projectId,
    title: "Parent",
    providerInstanceId: scope.providerInstanceId,
    modelSelection: { instanceId: scope.providerInstanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { rootThreadId: scope.threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    latestRunId: runId,
    activeRunId,
    status: "running",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
  };
}
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "code-mode-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "code-mode-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const listResult = {
  projectId,
  currentThreadId: scope.threadId,
  threads: [],
  nextCursor: null,
  total: 0,
};
const decodeExecution = Schema.decodeUnknownEffect(CodeModeExecutionResult);
function testLayer(
  options: {
    listThreads?: OrchestratorMcpService["Service"]["listThreads"];
    getThreadShell?: ThreadManagementService["Service"]["getThreadShell"];
    onRevoke?: McpSessionRegistry["Service"]["onRevoke"];
    events?: ThreadManagementService["Service"]["streamStoredEvents"];
  } = {},
) {
  return McpServer.toolkit(CodeModeToolkit).pipe(
    Layer.provide(CodeModeHandlersLive),
    Layer.provide(CodeModeDispatchLive),
    Layer.provide(CodeModeService.memoryLayer),
    Layer.provide(OrchestratorToolkitHandlersLive),
    Layer.provide(ThreadToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(OrchestratorMcpService)({
          listThreads: options.listThreads ?? (() => Effect.succeed(listResult)),
        }),
        Layer.mock(ThreadManagementService)({
          streamStoredEvents: options.events ?? Stream.never,
          getThreadShell: options.getThreadShell ?? (() => Effect.succeed(shell())),
          getProjectThread: ({ projectId, threadId }) =>
            Effect.fail(new ThreadManagementThreadNotFoundError({ projectId, threadId })),
        }),
        Layer.mock(ThreadMetadataMcpService)({}),
        Layer.mock(ProjectionSnapshotQuery)({}),
        Layer.mock(ScheduledTaskService)({}),
        options.onRevoke
          ? Layer.mock(McpSessionRegistry)({ onRevoke: options.onRevoke })
          : RegistryTestkit.layer,
      ),
    ),
  );
}
const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });
const execution = (name: string, args: Record<string, unknown>) =>
  call(name, args).pipe(Effect.flatMap((result) => decodeExecution(result.structuredContent)));

it.effect("executes existing handlers through MCP and discovers their current schemas", () =>
  Effect.gen(function* () {
    const describe = yield* call("t3_code_mode_describe", { tool: "t3_thread_list" });
    expect(describe.structuredContent).toMatchObject({
      name: "t3_thread_list",
      parameters: { type: "object" },
    });
    const result = yield* execution("t3_code_mode_exec", {
      code: "const r = await t3.t3_thread_list({}); return {total:r.total,projectId:r.projectId};",
    });
    expect(result).toMatchObject({ status: "completed", result: { total: 0, projectId } });
  }).pipe(Effect.provide(testLayer())),
);

it.effect("preserves schema validation, structured tool failures, and thread access checks", () =>
  Effect.gen(function* () {
    const result = yield* execution("t3_code_mode_exec", {
      code: `
    const errors = [];
    for (const fn of [
      () => t3.t3_thread_list({limit: -1}),
      () => t3.t3_thread_list({}),
      () => t3.t3_thread_organize({threadId:'other-project-thread',action:'pin'}),
    ]) { try { await fn(); } catch(e) { errors.push(e.code ?? 'validation'); } }
    return errors;
  `,
    });
    expect(result).toMatchObject({
      status: "completed",
      result: ["validation", "capability_denied", "thread_not_found"],
    });
  }).pipe(
    Effect.provide(
      testLayer({
        listThreads: () =>
          Effect.fail(
            new OrchestratorMcpFailure({ code: "capability_denied", message: "Denied by handler" }),
          ),
      }),
    ),
  ),
);

it.effect("returns handles while calls overlap, waits without replay, and recovers journals", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const layer = testLayer({
      listThreads: (invocation) =>
        Effect.gen(function* () {
          expect(invocation).toEqual(scope);
          calls++;
          if (calls === 2) yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return listResult;
        }),
    });
    yield* Effect.gen(function* () {
      const running = yield* execution("t3_code_mode_exec", {
        code: "return await Promise.all([t3.t3_thread_list({}), t3.t3_thread_list({})]);",
        yieldAfterMs: 0,
      });
      expect(running.status).toBe("running");
      yield* Deferred.await(started);
      const foreign = yield* call(
        "t3_code_mode_wait",
        { executionId: running.executionId, waitMs: 0 },
        { ...scope, providerSessionId: "foreign" },
      );
      expect(foreign.structuredContent).toMatchObject({ code: "invalid_request" });
      yield* Deferred.succeed(release, undefined);
      const done = yield* execution("t3_code_mode_wait", {
        executionId: running.executionId,
        includeCalls: true,
      });
      expect(done.status).toBe("completed");
      expect(done.calls).toHaveLength(2);
      yield* execution("t3_code_mode_wait", { executionId: running.executionId });
      expect(calls).toBe(2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("cancels a detached execution when its credential is revoked", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let revoke = () => {};
    yield* Effect.gen(function* () {
      const running = yield* execution("t3_code_mode_exec", {
        code: "await t3.t3_thread_list({}); return 1;",
        yieldAfterMs: 0,
      });
      yield* Deferred.await(started);
      revoke();
      yield* Deferred.await(interrupted);
      const done = yield* execution("t3_code_mode_wait", { executionId: running.executionId });
      expect(done.status).toBe("cancelled");
    }).pipe(
      Effect.provide(
        testLayer({
          onRevoke: (_, callback) =>
            Effect.sync(() => {
              revoke = callback;
              return () => {};
            }),
          listThreads: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        }),
      ),
    );
  }),
);

it.effect("rejects dispatch after the originating turn changes", () =>
  Effect.gen(function* () {
    let activeRunId = runId;
    let calls = 0;
    yield* Effect.gen(function* () {
      const result = yield* execution("t3_code_mode_exec", {
        code: "await t3.t3_thread_list({}); return await t3.t3_thread_list({});",
      });
      expect(result.status).toBe("failed");
      expect(result.error).toContain("originating turn");
      expect(calls).toBe(1);
      expect(result.calls).toHaveLength(2);
    }).pipe(
      Effect.provide(
        testLayer({
          getThreadShell: () => Effect.succeed(shell(activeRunId)),
          listThreads: () =>
            Effect.sync(() => {
              calls++;
              activeRunId = RunId.make("new-turn");
              return listResult;
            }),
        }),
      ),
    );
  }),
);

it.effect(
  "terminates a waiting host when the originating run ends, without another tool call",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const event: OrchestrationV2StoredEvent = {
        sequence: 1,
        commandId: null,
        event: {
          id: EventId.make("code-mode-ended"),
          threadId: scope.threadId,
          occurredAt: now,
          type: "run.updated",
          payload: {
            id: runId,
            threadId: scope.threadId,
            ordinal: 1,
            providerInstanceId: scope.providerInstanceId,
            modelSelection: shell().modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("code-mode-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      };
      yield* Effect.gen(function* () {
        const running = yield* execution("t3_code_mode_exec", {
          code: "await t3.t3_thread_list({});",
          yieldAfterMs: 0,
        });
        yield* Deferred.await(started);
        yield* Deferred.succeed(ended, undefined);
        yield* Deferred.await(interrupted);
        const done = yield* execution("t3_code_mode_wait", { executionId: running.executionId });
        expect(done.status).toBe("cancelled");
      }).pipe(
        Effect.provide(
          testLayer({
            events: Stream.fromEffect(Deferred.await(ended).pipe(Effect.as(event))),
            listThreads: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              ),
          }),
        ),
      );
    }),
);
