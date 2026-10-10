import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:mcp-create");
const parentThreadId = ThreadId.make("thread:mcp-create-parent");
const modelSelection = { instanceId, model: "gpt-5" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("MCP creation tests do not execute providers"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
const orchestration = ProviderReplayHarness.layerWithRegistry({ name: "mcp-create" }, registry, {
  databaseLayer: database,
  runEffectWorker: false,
});
const dependencies = Layer.mergeAll(
  NodeServices.layer,
  orchestration,
  registry,
  ThreadManagement.layer.pipe(Layer.provide(orchestration)),
  CommandReceiptStore.layer.pipe(Layer.provide(database)),
  ThreadCommandExecutor.layer,
  ProviderRegistryMock.layer([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-01T00:00:00.000Z",
      models: [
        { slug: modelSelection.model, name: "Test model", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
    },
  ]),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
);
const layer = OrchestratorMcpService.layer.pipe(Layer.provideMerge(dependencies));
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-create"),
  requestNamespace: "provider-session:mcp-create",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:mcp-create",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const createParent = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-parent"),
    threadId: parentThreadId,
    projectId,
    title: "Parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: "/repo-worktree",
    createdBy: "user",
    creationSource: "web",
  });
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("start-parent"),
    threadId: parentThreadId,
    messageId: MessageId.make("message:parent"),
    text: "Create another thread",
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});

it.effect("retries an interrupted MCP create with a prompt after reopening its target", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* createParent;
    const input = {
      clientRequestId: "interrupted-create",
      threads: [{ title: "Child", prompt: "Inspect the change" }],
    };
    const created = yield* Deferred.make<{ commandId: CommandId; threadId: ThreadId }>();
    const commitCommand = sink.commitCommand;
    const spy = vi.spyOn(sink, "commitCommand").mockImplementation((command) =>
      command.commandType === "thread.create"
        ? commitCommand(command).pipe(
            Effect.tap(() => Deferred.succeed(created, command)),
            Effect.andThen(Effect.never),
          )
        : commitCommand(command),
    );
    yield* Effect.gen(function* () {
      const creating = yield* service.createThreads(scope, input).pipe(Effect.forkChild());
      const claim = yield* Deferred.await(created);
      yield* Fiber.interrupt(creating);
      const threadId = claim.threadId;
      const messageCommandId = CommandId.make(
        String(claim.commandId).replace("create-thread", "dispatch-thread"),
      );
      assert.equal(
        Option.getOrThrow(yield* receipts.getByCommandId(claim.commandId)).status,
        "accepted",
      );
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-created-target"),
        threadId,
      });
      const refused = yield* service.createThreads(scope, input).pipe(Effect.flip);
      assert.equal(refused.code, "orchestration_error");
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(messageCommandId)));
      assert.isEmpty((yield* threads.getThreadProjection(threadId)).messages);
      yield* threads.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("reopen-created-target"),
        threadId,
      });
      const retried = yield* service.createThreads(scope, input);
      assert.equal(retried.threads[0]?.threadId, threadId);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.lengthOf(projection.messages, 1);
      assert.equal(projection.messages[0]?.senderThreadId, parentThreadId);
      assert.equal(projection.messages[0]?.text, input.threads[0]?.prompt);
      assert.equal(projection.thread.createdBy, "agent");
      assert.equal(projection.thread.creationSource, "mcp");
      assert.equal(projection.thread.branch, "feature");
      assert.equal(projection.thread.worktreePath, "/repo-worktree");
      assert.lengthOf(projection.runs, 1);
      assert.equal(
        Option.getOrThrow(yield* receipts.getByCommandId(messageCommandId)).status,
        "accepted",
      );
      yield* service.createThreads(scope, input);
      assert.lengthOf((yield* threads.getThreadProjection(threadId)).messages, 1);
    }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
  }).pipe(Effect.provide(layer)),
);

it.effect("accepts an MCP prompt before a concurrent archive can take its target", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    yield* createParent;
    const created = yield* Deferred.make<ThreadId>();
    const allowMessage = yield* Deferred.make<void>();
    const archiveQueued = yield* Deferred.make<void>();
    const commitCommand = sink.commitCommand;
    const withLock = executor.withLock;
    const commitSpy = vi.spyOn(sink, "commitCommand").mockImplementation((command) =>
      command.commandType === "thread.create"
        ? commitCommand(command).pipe(
            Effect.tap(() => Deferred.succeed(created, command.threadId)),
            Effect.tap(() => Deferred.await(allowMessage)),
          )
        : commitCommand(command),
    );
    yield* Effect.gen(function* () {
      const creating = yield* service
        .createThreads(scope, {
          clientRequestId: "concurrent-create",
          threads: [{ prompt: "Accept before archive" }],
        })
        .pipe(Effect.forkChild());
      const threadId = yield* Deferred.await(created);
      const observeLock: typeof withLock = (key, effect) =>
        key === threadId || key === parentThreadId
          ? Deferred.succeed(archiveQueued, undefined).pipe(Effect.andThen(withLock(key, effect)))
          : withLock(key, effect);
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const archiving = yield* threads
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("archive-concurrent-create"),
            threadId,
          })
          .pipe(Effect.flip, Effect.forkChild());
        yield* Deferred.await(archiveQueued);
        assert.isNull((yield* threads.getThreadProjection(threadId)).thread.archivedAt);
        yield* Deferred.succeed(allowMessage, undefined);
        const result = yield* Fiber.join(creating);
        assert.equal(result.threads[0]?.threadId, threadId);
        yield* Fiber.join(archiving);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.lengthOf(projection.messages, 1);
        assert.isNull(projection.thread.archivedAt);
      }).pipe(Effect.ensuring(Effect.sync(() => lockSpy.mockRestore())));
    }).pipe(Effect.ensuring(Effect.sync(() => commitSpy.mockRestore())));
  }).pipe(Effect.provide(layer)),
);

it.effect("creates and replays an idle MCP thread without a prompt", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* createParent;
    const input = { clientRequestId: "idle-create", threads: [{ title: "Later" }] };
    const created = yield* service.createThreads(scope, input);
    const replayed = yield* service.createThreads(scope, input);
    assert.deepEqual(replayed, created);
    const result = created.threads[0]!;
    assert.equal(result.status, "idle");
    assert.isNull(result.runId);
    const projection = yield* threads.getThreadProjection(result.threadId);
    assert.isEmpty(projection.messages);
    assert.isEmpty(projection.runs);
  }).pipe(Effect.provide(layer)),
);
