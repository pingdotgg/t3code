import { assert, it } from "@effect/vitest";
import {
  ChatFileAttachment,
  ChatImageAttachment,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";

const cases = (["codex", "claudeAgent"] as const).map((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = {
    instanceId,
    model: "test-model",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const adapter: ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("No live provider is launched by this test"),
  };
  return {
    driver,
    instanceId,
    modelSelection,
    layer: ProviderReplayHarness.layerWithRegistry(
      { name: `side-chat-${driver}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { runEffectWorker: false },
    ),
  };
});

it.effect.each(cases)(
  "captures streaming $driver context once, isolates tabs, and keeps or closes them",
  ({ modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const source = ThreadId.make("side-source");
      const first = ThreadId.make("side-one");
      const second = ThreadId.make("side-two");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-main"),
        threadId: source,
        projectId: ProjectId.make("side-project"),
        title: "Main",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const open = (targetThreadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.side-chat.create",
          commandId: CommandId.make(`open:${targetThreadId}`),
          sourceThreadId: source,
          targetThreadId,
          createdBy: "user",
          creationSource: "web",
        });
      // Empty main conversations are also valid sources.
      yield* open(first);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("main-turn"),
        threadId: source,
        messageId: MessageId.make("main-request"),
        text: "ORIGINAL_CONSTRAINT",
        attachments: [
          ChatFileAttachment.make({
            type: "file",
            id: "snapshot-file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 20,
          }),
          ChatImageAttachment.make({
            type: "image",
            id: "snapshot-image",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 30,
          }),
        ],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const main = yield* orchestrator.getThreadProjection(source);
      // SQL projections include outgoing transfers as well as incoming ones.
      // Sending in the source must leave its child's snapshot available.
      assert.equal(
        main.contextTransfers.find((transfer) => transfer.targetThreadId === first)!.status,
        "pending",
      );
      assert.lengthOf(main.contextHandoffs, 0);
      const userItem = main.turnItems.find((item) => item.type === "user_message")!;
      const now = yield* DateTime.now;
      const partial: OrchestrationV2TurnItem = {
        ...userItem,
        type: "assistant_message",
        id: TurnItemId.make("partial-output"),
        messageId: MessageId.make("partial-message"),
        text: "PARTIAL_SNAPSHOT",
        attachments: [],
        streaming: true,
        status: "running",
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("partial"),
            type: "turn-item.updated",
            threadId: source,
            occurredAt: now,
            payload: partial,
          },
        ],
      });
      yield* open(second);
      const side = yield* orchestrator.getThreadProjection(second);
      const frozen = side.contextTransfers[0]!.snapshotHistory!;
      assert.include(frozen.messages.map((m) => m.text).join("\n"), "PARTIAL_SNAPSHOT");
      assert.isTrue(frozen.messages.some((m) => m.status === "running"));
      assert.include(frozen.coverage, `main thread ${source} in the same T3 environment`);
      assert.include(frozen.coverage, "t3_thread_send");
      assert.equal(side.thread.lineage.parentThreadId, source);
      const snapshotText = frozen.messages.map((m) => m.text).join("\n");
      assert.include(snapshotText, "Attachment: notes.txt (file; id=snapshot-file)");
      assert.include(snapshotText, "Attachment: screen.png (image; id=snapshot-image)");
      yield* sink.write({
        events: [
          {
            id: EventId.make("later-output"),
            type: "turn-item.updated",
            threadId: source,
            occurredAt: now,
            payload: { ...partial, text: "LATER_OUTPUT" },
          },
        ],
      });
      // Continue independently while the source is still starting/running.
      for (const target of [first, second]) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`ask:${target}`),
          threadId: target,
          messageId: MessageId.make(`question:${target}`),
          text: "SIDE_QUESTION",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const a = yield* orchestrator.getThreadProjection(first);
      const b = yield* orchestrator.getThreadProjection(second);
      const currentMain = yield* orchestrator.getThreadProjection(source);
      assert.notEqual(
        a.providerThreads[0]!.providerSessionId,
        b.providerThreads[0]!.providerSessionId,
      );
      assert.notEqual(
        b.providerThreads[0]!.providerSessionId,
        currentMain.providerThreads[0]!.providerSessionId,
      );
      assert.lengthOf(a.contextHandoffs, 1);
      assert.include(a.contextHandoffs[0]!.summaryText, `main thread ${source}`);
      assert.isNull(b.providerThreads[0]!.forkedFrom);
      assert.include(b.contextHandoffs[0]!.summaryText, "PARTIAL_SNAPSHOT");
      assert.notInclude(b.contextHandoffs[0]!.summaryText, "LATER_OUTPUT");
      assert.deepEqual(b.thread.modelSelection, modelSelection);
      assert.include(b.contextHandoffs[0]!.summaryText, "id=snapshot-image");
      assert.deepEqual(
        currentMain.messages[0]!.attachments.map((a) => a.id),
        ["snapshot-file", "snapshot-image"],
      );
      assert.lengthOf(b.messages, 1);
      assert.lengthOf(currentMain.messages, 1);
      assert.equal(currentMain.thread.id, source);
      assert.equal(b.contextTransfers[0]!.status, "consumed");
      // Upstream secret cards must route to their own thread even when a
      // temporary conversation and its source both have active runs.
      for (const projection of [currentMain, b]) {
        const run = projection.runs[0]!;
        assert.isNotNull(run.rootNodeId);
        const turnItemId = TurnItemId.make(`secret:${projection.thread.id}`);
        for (const secretStatus of ["pending", "saved"] as const) {
          yield* orchestrator.dispatch({
            type: "secret_request.record",
            commandId: CommandId.make(`record:${turnItemId}:${secretStatus}`),
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: run.rootNodeId!,
            turnItemId,
            label: "Test secret",
            reason: "Thread routing regression",
            secretStatus,
          });
          const updated = yield* orchestrator.getThreadProjection(projection.thread.id);
          const cards = updated.turnItems.filter((item) => item.type === "secret_request");
          assert.lengthOf(cards, 1);
          assert.equal(cards[0]!.id, turnItemId);
          assert.equal(cards[0]!.secretStatus, secretStatus);
        }
      }
      assert.isFalse(
        (yield* orchestrator.getThreadProjection(first)).turnItems.some(
          (item) => item.type === "secret_request",
        ),
      );
      // Keep changes only navigation state and never starts or merges another turn.
      yield* orchestrator.dispatch({
        type: "thread.side-chat.keep",
        commandId: CommandId.make("keep-second"),
        threadId: second,
      });
      const kept = yield* orchestrator.getThreadProjection(second);
      assert.isNull(kept.thread.sideChatOf);
      assert.deepEqual(kept.contextHandoffs, b.contextHandoffs);
      assert.lengthOf(kept.runs, 1);
      yield* orchestrator.dispatch({
        type: "thread.side-chat.keep",
        commandId: CommandId.make("keep-second-again"),
        threadId: second,
      });
      const keptAgain = yield* orchestrator.getThreadProjection(second);
      assert.deepEqual(keptAgain.thread, kept.thread);
      assert.deepEqual(keptAgain.runs, kept.runs);

      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("close-first"),
        threadId: first,
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(first)).thread.deletedAt);
      const deleted = yield* orchestrator.getThreadProjection(first);
      const keepDeleted = yield* orchestrator
        .dispatch({
          type: "thread.side-chat.keep",
          commandId: CommandId.make("keep-deleted"),
          threadId: first,
        })
        .pipe(Effect.flip);
      assert.equal(keepDeleted._tag, "OrchestratorDispatchError");
      assert.deepEqual((yield* orchestrator.getThreadProjection(first)).thread, deleted.thread);

      assert.isNull((yield* orchestrator.getThreadProjection(source)).thread.deletedAt);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(cases)(
  "applies upstream dispatch mode limits when SideChat copies $driver source controls",
  ({ modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const source = ThreadId.make("limited-side-source");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-limited-source"),
        threadId: source,
        projectId: ProjectId.make("side-project"),
        title: "Main",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const limit of [
        { runtimeMode: "approval-required", interactionMode: "default", mode: "runtime" },
        { runtimeMode: "full-access", interactionMode: "plan", mode: "interaction" },
      ] as const) {
        const target = ThreadId.make(`limited-side-${limit.mode}`);
        const error = yield* orchestrator
          .dispatch({
            type: "thread.side-chat.create",
            commandId: CommandId.make(`limited-open-${limit.mode}`),
            sourceThreadId: source,
            targetThreadId: target,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.provideService(DispatchModeLimit, limit), Effect.flip);
        assert.equal(error._tag, "OrchestratorThreadAboveModeLimitError");
        assert.isNull(yield* orchestrator.getThreadShell(target));
      }
      // User commands remain unrestricted and copy the source's actual controls.
      const target = ThreadId.make("user-side");
      yield* orchestrator.dispatch({
        type: "thread.side-chat.create",
        commandId: CommandId.make("user-open"),
        sourceThreadId: source,
        targetThreadId: target,
        createdBy: "user",
        creationSource: "web",
      });
      const side = yield* orchestrator.getThreadProjection(target);
      assert.equal(side.thread.runtimeMode, "full-access");
      assert.equal(side.thread.interactionMode, "default");
      assert.deepEqual(side.thread.modelSelection, modelSelection);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(cases)(
  "refuses existing and deleted SideChat targets without changing $driver conversations",
  ({ modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const source = ThreadId.make("collision-source");
      const side = ThreadId.make("collision-side");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("collision-create"),
        threadId: source,
        projectId: ProjectId.make("side-project"),
        title: "Preserve me",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const open = (targetThreadId: ThreadId, suffix: string) =>
        orchestrator.dispatch({
          type: "thread.side-chat.create",
          commandId: CommandId.make(`collision-open:${suffix}`),
          sourceThreadId: source,
          targetThreadId,
          createdBy: "user",
          creationSource: "web",
        });
      yield* open(side, "first");
      for (const [target, suffix] of [
        [source, "main"],
        [side, "side"],
        [side, "deleted"],
      ] as const) {
        if (suffix === "deleted")
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("collision-delete"),
            threadId: side,
          });
        const before = yield* orchestrator.getThreadProjection(target);
        const error = yield* open(target, suffix).pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorThreadAlreadyExistsError");
        assert.deepEqual(yield* orchestrator.getThreadProjection(target), before);
      }
    }).pipe(Effect.provide(layer)),
);
