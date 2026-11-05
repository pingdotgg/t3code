import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-workspace" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:dispatch-mode-limit"),
      title: "Before",
      modelSelection: { instanceId, model: "gpt-5" },
      ...supervised,
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const destination = ProjectId.make("project:destination");
const addProject = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("destination-created"),
    aggregateKind: "project",
    aggregateId: destination,
    occurredAt: "2026-11-05T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: destination,
      title: "Destination",
      workspaceRoot: "/tmp/destination",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-05T00:00:00.000Z",
      updatedAt: "2026-11-05T00:00:00.000Z",
    },
  });
});
it.layer(layerTest)("Thread workspace changes", (it) => {
  it.effect("moves an existing thread, resets its checkout, and can select a worktree", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("workspace-move");
      yield* createThread(threadId);
      yield* addProject;
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("tree"),
        threadId,
        worktreePath: "/tmp/old-tree",
        branch: "old",
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("move"),
        threadId,
        projectId: destination,
      });
      const moved = yield* projections.getThread(threadId);
      assert.equal(moved.projectId, destination);
      assert.isNull(moved.worktreePath);
      assert.isNull(moved.branch);
      assert.equal(moved.title, "Before");
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("back"),
        threadId,
        projectId: destination,
        worktreePath: "/tmp/selected-tree",
        branch: "selected",
      });
      const back = yield* projections.getThread(threadId);
      assert.equal(back.worktreePath, "/tmp/selected-tree");
      assert.equal(back.branch, "selected");
    }),
  );
  it.effect("detaches an idle provider session on a project-only move", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("workspace-session");
      yield* createThread(threadId);
      yield* addProject;
      const now = yield* DateTime.now;
      const sessionId = ProviderSessionId.make("session:old-project");
      yield* projections.apply({
        id: EventId.make("session-attached"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        payload: {
          id: sessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/tmp/old-project",
          model: "gpt-5",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      const result = yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("move-session"),
        threadId,
        projectId: destination,
      });
      const detached = result.storedEvents.find(
        (stored) => stored.event.type === "provider-session.detached",
      );
      assert.isDefined(detached);
      if (detached?.event.type === "provider-session.detached") {
        assert.equal(detached.event.payload.providerSessionId, sessionId);
      }
    }),
  );
  it.effect("rejects a missing destination without changing ownership", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("workspace-invalid");
      yield* createThread(threadId);
      const result = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("invalid"),
          threadId,
          projectId: ProjectId.make("missing"),
        })
        .pipe(Effect.flip);
      assert.equal(result._tag, "OrchestratorDispatchError");
      assert.equal(
        (yield* projections.getThread(threadId)).projectId,
        ProjectId.make("project:dispatch-mode-limit"),
      );
    }),
  );
  it.effect("rejects workspace changes while a turn is pending", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("workspace-active");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send"),
        threadId,
        messageId: MessageId.make("message"),
        text: "work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      const result = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("active-move"),
          expectedIdle: true,
          threadId,
          worktreePath: "/tmp/new-tree",
        })
        .pipe(Effect.flip);
      assert.equal(result._tag, "OrchestratorDispatchError");
    }),
  );
});
