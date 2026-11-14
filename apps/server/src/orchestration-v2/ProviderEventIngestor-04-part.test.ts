import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  GitCommandError,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { toolOutputImages } from "@t3tools/shared/toolOutput";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeProviderEventRoutingState,
  type ProviderEventRouteIdentity,
  routeProviderEvent,
  selectInheritedBackgroundTurnItems,
} from "./RunExecutionService.ts";


import * as fixtures from "./ProviderEventIngestor-fixtures.testkit.ts";

const {
  CODEX_DRIVER,
  constraintFailure,
  ingestCompletedProviderTurn,
  layerFailingWrites,
  layerTest,
  lockTimeout,
  makeSharedWorktree,
  modelSelection,
  threadCreatedEvent,
} = fixtures;

const layer = it.layer(layerTest);

layer("ProviderEventIngestorV2", (it) => {
  it.effect("stores a bounded copy of a large file-change diff in both SQLite tables", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const threadEvent = yield* threadCreatedEvent(now);
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: threadEvent.threadId,
      });
      const largeDiff = `@@ -0,0 +1 @@\n${"+generated line\n".repeat(150_000)}`;
      const fileChange = (
        id: string,
        ordinal: number,
        diffStr: string,
      ): OrchestrationV2TurnItem => ({
        id: TurnItemId.make(id),
        threadId: threadEvent.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "file_change",
        fileName: "src/generated.ts",
        diffStr,
      });
      const large = fileChange("turn-item:large-diff", 1, largeDiff);
      const small = fileChange("turn-item:small-diff", 2, "@@ -1 +1 @@\n-old\n+new\n");

      yield* eventSink.write({ events: [threadEvent] });
      for (const turnItem of [large, small]) {
        yield* ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: threadEvent.threadId,
          event: { type: "turn_item.updated", driver: CODEX_DRIVER, turnItem },
        });
      }

      const sql = yield* SqlClient.SqlClient;
      const storedBytes = yield* sql<{ readonly events: number; readonly projection: number }>`
        SELECT
          (SELECT SUM(LENGTH(payload_json)) FROM orchestration_events
            WHERE stream_id = ${threadEvent.threadId} AND event_type = 'turn-item.updated') AS events,
          (SELECT SUM(LENGTH(payload_json)) FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadEvent.threadId}) AS projection
      `;
      const projectedLarge = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: large.id,
      });
      const projectedSmall = yield* projectionStore.getTurnItem({
        threadId: threadEvent.threadId,
        itemId: small.id,
      });

      assert.isAbove(largeDiff.length, 2_000_000);
      assert.isBelow(storedBytes[0]!.events, 100_000);
      assert.isBelow(storedBytes[0]!.projection, 100_000);
      assert.isTrue(projectedLarge?.type === "file_change");
      if (projectedLarge?.type !== "file_change") return;
      assert.equal(projectedLarge.fileName, "src/generated.ts");
      assert.isBelow(projectedLarge.diffStr?.length ?? 0, 40_000);
      assert.isTrue(largeDiff.startsWith(projectedLarge.diffStr?.split("\n…")[0] ?? "-"));
      assert.deepEqual(projectedSmall, small);
    }),
  );


  it.effect("routes provider-owned child artifacts to their child app thread", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") {
        throw new Error("Expected a thread.created fixture event");
      }
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-subagent-thread",
      });
      const childRootNodeId = NodeId.make("node:subagent-root");
      const childThread: OrchestrationV2AppThread = {
        ...rootEvent.payload,
        id: childThreadId,
        title: "inspect package",
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: rootEvent.threadId,
          relationshipToParent: "subagent",
          rootThreadId: rootEvent.threadId,
        },
        forkedFrom: {
          type: "node",
          nodeId: NodeId.make("node:parent-subagent"),
        },
      };
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });

      const threadEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "app_thread.created",
          driver: CODEX_DRIVER,
          appThread: childThread,
        },
      });
      const messageEvents = yield* ingestor.normalize({
        providerSessionId,
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
        event: {
          type: "message.updated",
          driver: CODEX_DRIVER,
          message: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make("message:subagent-response"),
            threadId: childThreadId,
            runId: null,
            nodeId: childRootNodeId,
            role: "assistant",
            text: "Subagent result",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      assert.equal(threadEvents[0]?.type, "thread.created");
      assert.equal(threadEvents[0]?.threadId, childThreadId);
      assert.equal(messageEvents[0]?.type, "message.updated");
      assert.equal(messageEvents[0]?.threadId, childThreadId);
    }),
  );

  it.effect.each([
    { parentMoved: false, failure: null },
    { parentMoved: true, failure: null },
    { parentMoved: false, failure: "write" },
    { parentMoved: false, failure: "git" },
  ])(
    "rechecks a pending native child's branch after the rename scan: %j",
    ({ parentMoved, failure }) =>
      Effect.gen(function* () {
        const { worktreePath, command } = yield* makeSharedWorktree;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const rootEvent = yield* threadCreatedEvent(now);
        if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
        const parent = {
          ...rootEvent.payload,
          branch: "t3/abcd1234",
          worktreePath,
        };
        yield* eventSink.write({ events: [{ ...rootEvent, payload: parent }] });
        const childId = ids.derive.threadFromProviderThread({
          driver: CODEX_DRIVER,
          nativeThreadId: `child-created-during-rename:${parentMoved}:${failure}`,
        });
        const beforeCommit = yield* Deferred.make<
          void,
          ProviderEventIngestor.ProviderEventIngestorV2Error
        >();
        const allowCommit = yield* Deferred.make<void>();
        let correctionWrites = 0;
        const gatedSink = EventSink.EventSinkV2.of({
          ...eventSink,
          write: (input) => {
            if (
              input.events.some(
                (event) => event.type === "thread.metadata-updated" && event.threadId === childId,
              )
            ) {
              correctionWrites++;
              if (failure === "write" && correctionWrites === 1)
                return Effect.fail(new EventSink.EventSinkWriteError({ eventCount: 1 }));
            }
            return input.events.some(
              (event) => event.type === "thread.created" && event.threadId === childId,
            )
              ? Deferred.succeed(beforeCommit, undefined).pipe(
                  Effect.andThen(Deferred.await(allowCommit)),
                  Effect.andThen(eventSink.write(input)),
                )
              : eventSink.write(input);
          },
        });
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
          Effect.provide(Layer.fresh(ProviderEventIngestor.layer)),
          Effect.provideService(EventSink.EventSinkV2, gatedSink),
          Effect.provideService(GitVcsDriver.GitVcsDriver, {
            ...git,
            resolveBranchName: (cwd, refName) =>
              failure === "git"
                ? Effect.fail(
                    new GitCommandError({
                      operation: "ingestor-test",
                      cwd,
                      command: "rev-parse",
                      detail: "Read failed",
                    }),
                  )
                : git.resolveBranchName(cwd, refName),
          }),
        );
        const providerSessionId = yield* ids.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId: parent.id,
        });
        const creationInput = {
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: parent.id,
          event: {
            type: "app_thread.created",
            driver: CODEX_DRIVER,
            appThread: {
              ...parent,
              id: childId,
              lineage: {
                parentThreadId: parent.id,
                rootThreadId: parent.id,
                relationshipToParent: "subagent",
              },
            },
          },
        } satisfies ProviderEventIngestor.ProviderEventIngestInput;
        const creation = yield* ingestor.ingestNormalized(creationInput).pipe(
          Effect.tapCause((cause) => Deferred.failCause(beforeCommit, cause)),
          Effect.forkScoped,
        );
        yield* Deferred.await(beforeCommit);
        yield* command(worktreePath, ["branch", "-m", "generated-branch"]);
        yield* eventSink.write({
          events: [
            {
              ...rootEvent,
              id: yield* ids.allocate.event({ threadId: parent.id }),
              type: "thread.metadata-updated",
              payload: {
                ...parent,
                branch: parentMoved ? "user/checkout" : "generated-branch",
                worktreePath: parentMoved ? `${worktreePath}-moved` : worktreePath,
              },
            },
          ],
        });
        const snapshot = yield* projections.getShellSnapshot();
        assert.isFalse(
          [...snapshot.threads, ...snapshot.archivedThreads].some(
            (thread) =>
              thread.worktreePath === parent.worktreePath && thread.branch === parent.branch,
          ),
        );
        yield* Deferred.succeed(allowCommit, undefined);
        const stored = yield* Fiber.join(creation);
        assert.equal(stored[0]?.event.type, "thread.created");
        const child = yield* projections.getThread(childId);
        assert.equal(child.branch, failure === null ? "generated-branch" : parent.branch);
        assert.equal(child.worktreePath, parent.worktreePath);
        assert.equal(correctionWrites, failure === "git" ? 0 : 1);
        assert.deepEqual(yield* ingestor.ingestNormalized(creationInput), []);
      }),
  );

  // regression: #20079 the renamed-branch correction must not rewrite a child that needs none
  it.effect.each(["explicit", "detached"])(
    "preserves a native child's branch when the checkout needs no correction: %s",
    (scenario) =>
      Effect.gen(function* () {
        const { worktreePath, command } = yield* makeSharedWorktree;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const branch = scenario === "explicit" ? "child-feature" : "t3/abcd1234";
        if (scenario === "explicit") yield* command(worktreePath, ["branch", "-m", branch]);
        if (scenario === "detached") yield* command(worktreePath, ["checkout", "--detach"]);
        const now = yield* DateTime.now;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const root = yield* threadCreatedEvent(now);
        if (root.type !== "thread.created") throw new Error("Expected thread fixture");
        yield* sink.write({
          events: [
            { ...root, payload: { ...root.payload, branch: "parent-feature", worktreePath } },
          ],
        });
        const childId = ids.derive.threadFromProviderThread({
          driver: CODEX_DRIVER,
          nativeThreadId: `no-correction:${scenario}`,
        });
        let gitReads = 0;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2.pipe(
          Effect.provide(Layer.fresh(ProviderEventIngestor.layer)),
          Effect.provideService(GitVcsDriver.GitVcsDriver, {
            ...git,
            resolveBranchName: (cwd, refName) => {
              gitReads++;
              return git.resolveBranchName(cwd, refName);
            },
          }),
        );
        const stored = yield* ingestor.ingestNormalized({
          providerSessionId: yield* ids.allocate.providerSession({
            providerInstanceId: modelSelection.instanceId,
            threadId: root.threadId,
          }),
          providerInstanceId: modelSelection.instanceId,
          threadId: root.threadId,
          event: {
            type: "app_thread.created",
            driver: CODEX_DRIVER,
            appThread: {
              ...root.payload,
              id: childId,
              branch,
              worktreePath,
              lineage: {
                parentThreadId: root.threadId,
                rootThreadId: root.threadId,
                relationshipToParent: "subagent",
              },
            },
          },
        });
        assert.equal((yield* projections.getThread(childId)).branch, branch);
        assert.equal(stored.length, 1);
        assert.equal(gitReads, scenario === "explicit" ? 0 : 1);
      }),
  );


  it.effect("updates provider child metadata without recreating its saved thread", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "workflow-member-metadata",
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });
      const offered = {
        ...rootEvent.payload,
        id: childThreadId,
        title: "Inspect checkout",
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: rootEvent.threadId,
          relationshipToParent: "subagent" as const,
          rootThreadId: rootEvent.threadId,
        },
      };
      const ingest = (appThread: OrchestrationV2AppThread) =>
        ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootEvent.threadId,
          event: { type: "app_thread.created", driver: CODEX_DRIVER, appThread },
        });
      yield* eventSink.write({ events: [rootEvent] });
      const created = yield* Effect.all([ingest(offered), ingest(offered)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(
        created.flat().map((stored) => stored.event.type),
        ["thread.created"],
      );
      const saved = {
        ...offered,
        archivedAt: now,
        deletedAt: now,
        activeProviderThreadId: rootEvent.payload.activeProviderThreadId,
        branch: "user/checkout",
      };
      yield* eventSink.write({
        events: [
          {
            ...rootEvent,
            id: yield* idAllocator.allocate.event({ threadId: childThreadId }),
            threadId: childThreadId,
            type: "thread.deleted",
            payload: saved,
          },
        ],
      });
      for (const metadata of [
        { title: "Review checkout", modelSelection },
        { title: "Review checkout", modelSelection: { ...modelSelection, model: "gpt-6.1-sol" } },
      ]) {
        const updated = yield* ingest({ ...offered, ...metadata });
        assert.deepEqual(
          updated.map((stored) => stored.event.type),
          ["thread.metadata-updated"],
        );
        const thread = yield* projectionStore.getThread(childThreadId);
        assert.deepEqual(thread, { ...saved, ...metadata, updatedAt: thread.updatedAt });
      }
      assert.deepEqual(
        yield* ingest({
          ...offered,
          title: "Review checkout",
          modelSelection: { ...modelSelection, model: "gpt-6.1-sol" },
        }),
        [],
      );
    }),
  );


  it.effect(
    "recovers a missing Claude child once and preserves saved metadata on later recovery",
    () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const eventSink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const rootEvent = yield* threadCreatedEvent(now);
        if (rootEvent.type !== "thread.created") throw new Error("Expected thread fixture");
        const driver = ProviderDriverKind.make("claude");
        const providerInstanceId = ProviderInstanceId.make("claude");
        const childThreadId = idAllocator.derive.threadFromProviderThread({
          driver,
          nativeThreadId: "recovered-claude-child",
        });
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId,
          threadId: rootEvent.threadId,
        });
        const recovered: OrchestrationV2AppThread = {
          ...rootEvent.payload,
          id: childThreadId,
          title: "Recovered subagent",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet-4-6" },
          activeProviderThreadId: null,
          createdBy: "agent",
          creationSource: "provider",
          lineage: {
            parentThreadId: rootEvent.threadId,
            relationshipToParent: "subagent",
            rootThreadId: rootEvent.threadId,
          },
        };
        const ingest = (appThread: OrchestrationV2AppThread, createOnly: boolean) =>
          ingestor.ingestNormalized({
            providerSessionId,
            providerInstanceId,
            threadId: rootEvent.threadId,
            event: { type: "app_thread.created", driver, appThread, createOnly },
          });
        yield* eventSink.write({ events: [rootEvent] });
        const created = yield* Effect.all([ingest(recovered, true), ingest(recovered, true)], {
          concurrency: "unbounded",
        });
        assert.deepEqual(
          created.flat().map((stored) => stored.event.type),
          ["thread.created"],
        );
        assert.deepEqual(yield* projectionStore.getThread(childThreadId), recovered);

        yield* ingest(
          {
            ...recovered,
            title: "Review authentication",
            modelSelection: { instanceId: providerInstanceId, model: "claude-opus-4-6" },
          },
          false,
        );
        const saved = yield* projectionStore.getThread(childThreadId);
        assert.equal(saved.title, "Review authentication");
        assert.equal(saved.modelSelection.model, "claude-opus-4-6");
        assert.deepEqual(yield* ingest(recovered, true), []);
        assert.deepEqual(yield* projectionStore.getThread(childThreadId), saved);
      }),
  );


  it.effect("moves a native subagent's thread to its later model through a database lock", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const rootEvent = yield* threadCreatedEvent(now);
      if (rootEvent.type !== "thread.created") {
        throw new Error("Expected a thread.created fixture event");
      }
      const childThreadId = idAllocator.derive.threadFromProviderThread({
        driver: CODEX_DRIVER,
        nativeThreadId: "native-late-model-subagent",
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: rootEvent.threadId,
      });
      const ingest = (event: ProviderEventIngestor.ProviderEventIngestInput["event"]) =>
        ingestor.ingestNormalized({
          providerSessionId,
          providerInstanceId: modelSelection.instanceId,
          threadId: rootEvent.threadId,
          event,
        });
      yield* eventSink.write({ events: [rootEvent] });
      yield* ingest({
        type: "app_thread.created",
        driver: CODEX_DRIVER,
        appThread: {
          ...rootEvent.payload,
          id: childThreadId,
          title: "review design",
          modelSelection: {
            ...modelSelection,
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: rootEvent.threadId,
            relationshipToParent: "subagent",
            rootThreadId: rootEvent.threadId,
          },
        },
      });
      const subagentUpdated = {
        type: "subagent.updated",
        driver: CODEX_DRIVER,
        subagent: {
          id: NodeId.make("node:late-model-subagent"),
          threadId: rootEvent.threadId,
          runId: null,
          parentNodeId: NodeId.make("node:root"),
          origin: "provider_native",
          createdBy: "agent",
          driver: CODEX_DRIVER,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Review the design",
          title: "review design",
          model: "gpt-6.1-sol",
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      } satisfies ProviderEventIngestor.ProviderEventIngestInput["event"];

      const first = yield* ingest(subagentUpdated);
      const repeated = yield* ingest(subagentUpdated);
      const childThread = yield* projectionStore.getThread(childThreadId);

      assert.deepEqual(
        first.map((stored) => [stored.event.type, stored.event.threadId]),
        [
          ["subagent.updated", rootEvent.threadId],
          ["thread.model-selection-updated", childThreadId],
        ],
      );
      assert.deepEqual(
        repeated.map((stored) => stored.event.type),
        ["subagent.updated"],
      );
      assert.deepEqual(childThread.modelSelection, {
        instanceId: modelSelection.instanceId,
        model: "gpt-6.1-sol",
      });

      const reportedSelection = {
        instanceId: modelSelection.instanceId,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const reported = yield* ingest({
        ...subagentUpdated,
        subagent: { ...subagentUpdated.subagent, modelSelection: reportedSelection },
      });
      assert.deepEqual(
        reported.map((stored) => stored.event.type),
        ["subagent.updated", "thread.model-selection-updated"],
      );
      assert.deepEqual(
        (yield* projectionStore.getThread(childThreadId)).modelSelection,
        reportedSelection,
      );

      const recovered = yield* ingest(subagentUpdated);
      assert.deepEqual(
        recovered.map((stored) => stored.event.type),
        ["subagent.updated"],
      );
      assert.deepEqual(
        (yield* projectionStore.getThread(childThreadId)).modelSelection,
        reportedSelection,
      );
    }).pipe(
      // Fresh: the shared test layer has already built the ingestor this replaces.
      Effect.provide(
        Layer.fresh(
          layerFailingWrites([lockTimeout, lockTimeout], (events) =>
            events.some((event) => event.type === "thread.model-selection-updated"),
          ),
        ),
      ),
    ),
  );
});

