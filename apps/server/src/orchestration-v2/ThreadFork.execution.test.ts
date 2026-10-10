import { assert, it } from "@effect/vitest";
import {
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

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (["codex", "claudeAgent"] as const).flatMap((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  return (["failed", "interrupted", "cancelled"] as const).map((status) => ({
    driver,
    status,
    instanceId,
    modelSelection,
    layer,
  }));
});

it.effect.each(forkCases)(
  "bounds $driver context when continuing a fork of a $status run",
  ({ driver, status, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      // A cancelled queue entry has no provider turn; an early interruption
      // can have a turn but no native assistant cursor.
      if (status === "interrupted") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      for (const ordinal of [1, 2]) {
        const runId = ordinal === 1 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: ordinal === 1 && status === "interrupted" ? attemptId : null,
                status: ordinal === 1 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 1 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);

const steeredForkCases = (["codex", "claudeAgent"] as const).map((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  return {
    driver,
    instanceId,
    modelSelection: { instanceId, model: "test-model" },
    // Claude's forkSession cuts at an SDK message uuid; Codex forks only at turn ends.
    expectedStrategy: driver === "codex" ? "portable_context" : "native_fork",
    layer: ProviderReplayHarness.layerWithRegistry(
      { name: `fork-steered-${driver}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { runEffectWorker: false },
    ),
  };
});

it.effect.each(steeredForkCases)(
  "forks $driver from a response a steer cut off, without the steer",
  ({ driver, instanceId, modelSelection, expectedStrategy, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-steered-source");
      const targetThreadId = ThreadId.make("fork-steered-target");
      const providerThreadId = ProviderThreadId.make("fork-steered-native-thread");
      const runId = RunId.make("fork-steered-run");
      const cutOffItemId = TurnItemId.make("fork-steered-cut-off-response");
      const steerItemId = TurnItemId.make("fork-steered-steer");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-steered-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-steered-project"),
        title: "Steered source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const itemBase = {
        threadId: sourceThreadId,
        runId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      } as const;
      const userItem = (id: string, text: string, inputIntent: "turn_start" | "steer") => ({
        ...itemBase,
        id: TurnItemId.make(id),
        nativeItemRef: null,
        type: "user_message" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        inputIntent,
        messageId: MessageId.make(id),
        text,
        attachments: [],
      });
      const assistantItem = (id: TurnItemId, text: string) => ({
        ...itemBase,
        id,
        nativeItemRef: { driver, nativeId: `sdk-uuid:${id}`, strength: "strong" as const },
        type: "assistant_message" as const,
        messageId: MessageId.make(id),
        text,
        streaming: false,
      });
      // Active steering keeps the steer and its reply in the same run.
      const items = [
        userItem("fork-steered-prompt", "INITIAL_PROMPT_MARKER", "turn_start"),
        assistantItem(cutOffItemId, "CUT_OFF_RESPONSE_MARKER"),
        userItem(steerItemId, "STEER_MARKER", "steer"),
        assistantItem(TurnItemId.make("fork-steered-reply"), "AFTER_STEER_REPLY_MARKER"),
      ];
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("steered-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("steered-run"),
            type: "run.created",
            threadId: sourceThreadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId,
              userMessageId: MessageId.make("fork-steered-prompt"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          ...items.map((item) => ({
            id: EventId.make(`steered-${item.id}`),
            type: "turn-item.updated" as const,
            threadId: sourceThreadId,
            runId,
            occurredAt: now,
            payload: item,
          })),
        ],
      });

      const forkAt = (turnItemId: TurnItemId, commandId: string) =>
        orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(commandId),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "turn_item", runId, turnItemId },
          createdBy: "user",
          creationSource: "web",
        });
      const steerFork = yield* Effect.exit(forkAt(steerItemId, "fork-at-steer"));
      assert.isTrue(steerFork._tag === "Failure", "a steer is not a response to fork from");

      // The run's last response cuts nothing, so it forks exactly like the run,
      // natively where the provider can fork at a turn end.
      const runEndTargetId = ThreadId.make("fork-steered-run-end-target");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-at-run-end-response"),
        sourceThreadId,
        targetThreadId: runEndTargetId,
        sourcePoint: { type: "turn_item", runId, turnItemId: items[3]!.id },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-run-end-fork"),
        threadId: runEndTargetId,
        messageId: MessageId.make("continue-run-end-fork"),
        text: "Continue from the run end",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const runEndFork = yield* orchestrator.getThreadProjection(runEndTargetId);
      assert.deepEqual(runEndFork.thread.forkedFrom, {
        type: "run",
        threadId: sourceThreadId,
        runId,
      });
      assert.isUndefined(runEndFork.contextTransfers[0]?.sourcePoint.turnItemId);
      assert.lengthOf(runEndFork.contextHandoffs, 0);
      assert.equal(runEndFork.providerThreads[0]?.forkedFrom?.providerThreadId, providerThreadId);

      yield* forkAt(cutOffItemId, "fork-at-cut-off-response");

      const forked = yield* orchestrator.getThreadProjection(targetThreadId);
      const inheritedText = forked.visibleTurnItems
        .flatMap(({ item }) =>
          item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
        )
        .join("\n");
      assert.equal(inheritedText, "INITIAL_PROMPT_MARKER\nCUT_OFF_RESPONSE_MARKER");
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === targetThreadId,
      );
      assert.equal(shell?.visibleItemCount, forked.visibleTurnItems.length);

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-steered-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-steered-fork"),
        text: "Continue from the cut-off response",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.contextTransfers[0]?.sourcePoint.turnItemId, cutOffItemId);
      if (expectedStrategy === "native_fork") {
        assert.lengthOf(target.contextHandoffs, 0);
        assert.equal(target.providerThreads[0]?.forkedFrom?.providerThreadId, providerThreadId);
        return;
      }
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      const handoff = target.contextHandoffs[0]!;
      const history = `${handoff.summaryText}\n${
        handoff.history?.messages.map((message) => message.text).join("\n") ?? ""
      }`;
      assert.include(history, "CUT_OFF_RESPONSE_MARKER");
      assert.notInclude(history, "STEER_MARKER");
      assert.notInclude(history, "AFTER_STEER_REPLY_MARKER");
    }).pipe(Effect.provide(layer)),
);
