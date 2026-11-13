import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { forkCases, writeParentRun } from "./ThreadFork.execution-part2.test.ts";

const writeImportedHistory = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${threadId}:imported`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...thread, historyOrigin: "v1_import" },
        },
        {
          id: EventId.make(`${threadId}:imported-item`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${threadId}:imported-item`),
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId: MessageId.make(`${threadId}:imported-message`),
            text,
            attachments: [],
          },
        },
      ],
    });
  });

const createParent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("side-chat-project"),
      title: "Side chat parent",
      modelSelection: forkCases[0]!.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const forkSideChat = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(commandId),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "latest_stable" },
      sideChat: true,
      createdBy: "user",
      creationSource: "web",
    });
  });

const askSideChat = (
  threadId: ThreadId,
  commandId: string,
  modelSelection?: (typeof forkCases)[number]["modelSelection"],
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(commandId),
      threadId,
      messageId: MessageId.make(commandId),
      text: "What is the main thread doing?",
      attachments: [],
      ...(modelSelection === undefined ? {} : { modelSelection }),
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("resolves an explicit checkpoint fork to its source run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const parentId = ThreadId.make("checkpoint-fork-parent");
    const childId = ThreadId.make("checkpoint-fork-child");
    const runId = RunId.make("checkpoint-fork-run");
    const checkpointId = CheckpointId.make("checkpoint-fork-checkpoint");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId,
      ordinal: 1,
      status: "completed",
      text: "Work",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("checkpoint-fork-captured"),
          type: "checkpoint.captured",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId: parentId,
            scopeId: CheckpointScopeId.make("checkpoint-fork-scope"),
            runId,
            nodeId: NodeId.make("checkpoint-fork-node"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: CheckpointRef.make("refs/t3/checkpoint-fork/1"),
            status: "ready",
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("checkpoint-fork"),
      sourceThreadId: parentId,
      targetThreadId: childId,
      sourcePoint: { type: "checkpoint", checkpointId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const child = yield* orchestrator.getThreadShell(childId);
    assert.deepEqual(child?.forkedFrom, { type: "run", threadId: parentId, runId });
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat of an idle parent still starts with the framing note", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-idle-parent");
    const sideChatId = ThreadId.make("side-chat-idle-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-idle-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });

    const reads: Array<string> = [];
    const recordReads: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (/^\s*SELECT/i.test(query)) reads.push(query);
      return Effect.succeed(statement);
    };
    yield* forkSideChat("side-chat-idle-fork", parentId, sideChatId).pipe(
      Effect.provideService(Statement.CurrentTransformer, recordReads),
    );
    assert.isEmpty(
      reads.filter(
        (query) =>
          query.includes("FROM orchestration_v2_projection_checkpoints") ||
          query.includes("FROM orchestration_v2_projection_context_transfers"),
      ),
    );
    yield* askSideChat(sideChatId, "side-chat-idle-first-message", {
      ...forkCases[0]!.modelSelection,
      model: "side-chat-model",
    });

    const started = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isNotNull(started.providerThreads[0]?.forkedFrom);
    // The side chat does not show the parent's run, so it is no baseline.
    assert.isFalse(
      started.turnItems.some((item) => item.type === "user_message" && item.modelSwitch),
    );
    assert.lengthOf(started.contextHandoffs, 1);
    const [handoff] = started.contextHandoffs;
    assert.isTrue(
      handoff!.summaryText.startsWith("You are in a side chat beside the main thread."),
    );
    assert.notInclude(handoff!.summaryText, "Main thread activity");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat waits for the parent's new worktree, also after its setup ended", () =>
  Effect.gen(function* () {
    for (const status of ["preparing", "failed", "interrupted"] as const) {
      const parentId = ThreadId.make(`side-chat-worktree-parent-${status}`);
      yield* createParent(parentId);
      yield* writeParentRun({
        threadId: parentId,
        runId: RunId.make(`side-chat-worktree-parent-run-${status}`),
        ordinal: 1,
        status,
        text: "Parent work",
      });

      const rejected = yield* forkSideChat(
        `side-chat-worktree-fork-${status}`,
        parentId,
        ThreadId.make(`side-chat-worktree-child-${status}`),
      ).pipe(Effect.flip);
      assert.include(String(rejected.cause), "has no worktree yet", status);
    }
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("closing a side chat deletes it only while unused; a deleted parent takes no more", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-close-parent");
    const unused = ThreadId.make("side-chat-close-unused");
    const used = ThreadId.make("side-chat-close-used");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-close-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });
    yield* forkSideChat("side-chat-close-fork-unused", parentId, unused);
    yield* forkSideChat("side-chat-close-fork-used", parentId, used);
    yield* askSideChat(used, "side-chat-close-used-message");
    const close = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`side-chat-close:${threadId}`),
        threadId,
        onlyIfUnused: true,
      });

    yield* close(unused);
    yield* close(used);
    assert.isNotNull((yield* orchestrator.getThreadProjection(unused)).thread.deletedAt);
    assert.isNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-close-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);
    const orphan = yield* forkSideChat(
      "side-chat-close-orphan",
      parentId,
      ThreadId.make("side-chat-close-orphan"),
    ).pipe(Effect.flip);
    assert.include(String(orphan.cause), "was deleted");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a side chat opened during the parent's first turn starts from a digest", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const grandparentId = ThreadId.make("side-chat-busy-grandparent");
    const grandparentRunId = RunId.make("side-chat-busy-grandparent-run");
    const parentId = ThreadId.make("side-chat-busy-parent");
    const sideChatId = ThreadId.make("side-chat-busy-child");
    yield* createParent(grandparentId);
    yield* writeParentRun({
      threadId: grandparentId,
      runId: grandparentRunId,
      ordinal: 1,
      status: "completed",
      text: "GRANDPARENT_MARKER",
      stable: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("side-chat-busy-parent-fork"),
      sourceThreadId: grandparentId,
      targetThreadId: parentId,
      sourcePoint: { type: "run", runId: grandparentRunId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeImportedHistory(parentId, "PARENT_IMPORTED_MARKER");
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-rewound-parent-run"),
      ordinal: 1,
      status: "rolled_back",
      text: "PARENT_ROLLED_BACK_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-busy-parent-run"),
      ordinal: 2,
      status: "running",
      text: "PARENT_RUNNING_MARKER",
    });
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-queued-parent-run"),
      ordinal: 3,
      status: "queued",
      text: "PARENT_QUEUED_MARKER",
    });
    const fork = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(commandId),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

    yield* fork("side-chat-busy-fork", parentId, sideChatId);
    const created = yield* orchestrator.getThreadProjection(sideChatId);
    assert.isTrue(created.thread.lineage.sideChat);
    assert.equal(created.thread.runtimeMode, "approval-required");
    assert.isNull(created.thread.forkedFrom);
    assert.deepEqual(created.contextTransfers[0]?.sourcePoint, { threadId: parentId });

    const nested = yield* fork(
      "side-chat-busy-nested",
      sideChatId,
      ThreadId.make("side-chat-busy-nested"),
    ).pipe(Effect.flip);
    assert.equal(nested._tag, "OrchestratorDispatchError");
    // Either would take the side chat's lock before the parent's, against the delete cascade.
    const ontoParent = yield* fork("side-chat-busy-onto-parent", sideChatId, parentId).pipe(
      Effect.flip,
    );
    assert.equal(ontoParent._tag, "OrchestratorThreadAlreadyExistsError");
    const ontoExisting = yield* fork("side-chat-busy-onto-existing", parentId, sideChatId).pipe(
      Effect.flip,
    );
    assert.equal(ontoExisting._tag, "OrchestratorThreadAlreadyExistsError");
    const plainOntoExisting = yield* orchestrator
      .dispatch({
        type: "thread.fork",
        commandId: CommandId.make("side-chat-busy-plain-onto-existing"),
        sourceThreadId: parentId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.equal(plainOntoExisting._tag, "OrchestratorThreadAlreadyExistsError");
    const busyMergeBack = yield* orchestrator
      .dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make("side-chat-busy-merge-back"),
        sourceThreadId: sideChatId,
        targetThreadId: parentId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(String(busyMergeBack.cause), "active work");

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("side-chat-busy-first-message"),
      threadId: sideChatId,
      messageId: MessageId.make("side-chat-busy-first-message"),
      text: "What is the main thread doing?",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const started = yield* orchestrator.getThreadProjection(sideChatId);
    const [handoff] = started.contextHandoffs;
    assert.lengthOf(started.contextHandoffs, 1);
    assert.deepEqual(started.contextTransfers[0]?.resolution, {
      strategy: "portable_context",
      contextHandoffId: handoff!.id,
    });
    assert.include(handoff!.summaryText, "You are in a side chat beside the main thread.");
    // Inherited rows come first, so the cap truncates them first.
    assert.isAbove(
      handoff!.summaryText.indexOf("- User: PARENT_IMPORTED_MARKER"),
      handoff!.summaryText.indexOf("- User: GRANDPARENT_MARKER"),
    );
    assert.include(handoff!.summaryText, "- User: GRANDPARENT_MARKER");
    assert.notInclude(handoff!.summaryText, "PARENT_ROLLED_BACK_MARKER");
    assert.notInclude(handoff!.summaryText, "PARENT_QUEUED_MARKER");
    assert.include(handoff!.summaryText, "- User: PARENT_IMPORTED_MARKER");
    assert.include(handoff!.summaryText, "- User: PARENT_RUNNING_MARKER");
    assert.include(handoff!.summaryText, `t3_thread_read on thread ${parentId}`);
    assert.equal(
      started.messages.find((message) => message.role === "user")?.text,
      "What is the main thread doing?",
    );

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-busy-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("merge-back rejects a second fork's context until the first is consumed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("merge-back-guard-parent");
    const parentRunId = RunId.make("merge-back-guard-parent-run");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: parentRunId,
      ordinal: 1,
      status: "completed",
      text: "Parent work",
    });
    const forkAndRun = (name: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`merge-back-guard-${name}`);
        const runId = RunId.make(`merge-back-guard-${name}-run`);
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`merge-back-guard-fork-${name}`),
          sourceThreadId: parentId,
          targetThreadId: threadId,
          sourcePoint: { type: "run", runId: parentRunId },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* writeParentRun({ threadId, runId, ordinal: 1, status: "completed", text: name });
        return { threadId, runId };
      });
    const mergeBack = (commandId: string, fork: { threadId: ThreadId; runId: RunId }) =>
      orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make(commandId),
        sourceThreadId: fork.threadId,
        targetThreadId: parentId,
        sourcePoint: { type: "run", runId: fork.runId },
        createdBy: "user",
        creationSource: "web",
      });
    const first = yield* forkAndRun("first");
    const second = yield* forkAndRun("second");

    yield* mergeBack("merge-back-guard-first", first);
    const rejected = yield* mergeBack("merge-back-guard-second", second).pipe(Effect.flip);
    assert.include(String(rejected.cause), "pending context from another side chat or fork");
    yield* mergeBack("merge-back-guard-first-again", first);
    // That pending merge-back targets the parent, so it does not block one into `first`.
    const nested = { threadId: ThreadId.make("merge-back-guard-nested") };
    const nestedRunId = RunId.make("merge-back-guard-nested-run");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("merge-back-guard-fork-nested"),
      sourceThreadId: first.threadId,
      targetThreadId: nested.threadId,
      sourcePoint: { type: "run", runId: first.runId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeParentRun({
      threadId: nested.threadId,
      runId: nestedRunId,
      ordinal: 1,
      status: "completed",
      text: "nested",
    });
    yield* orchestrator.dispatch({
      type: "thread.merge_back",
      commandId: CommandId.make("merge-back-guard-nested"),
      sourceThreadId: nested.threadId,
      targetThreadId: first.threadId,
      sourcePoint: { type: "run", runId: nestedRunId },
      createdBy: "user",
      creationSource: "web",
    });

    const parent = yield* orchestrator.getThreadProjection(parentId);
    assert.deepEqual(
      parent.contextTransfers
        .filter((transfer) => transfer.type === "merge_back")
        .map((transfer) => [transfer.sourceThreadId, transfer.status]),
      [
        [first.threadId, "superseded"],
        [first.threadId, "pending"],
      ],
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);
