import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { CopilotAdapterValidationError } from "../../provider/Services/CopilotAdapter.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  COPILOT_DRIVER_KIND,
  makeCopilotAdapterV2,
  type CopilotAdapterV2LegacyPort,
} from "./CopilotAdapterV2.ts";

const INSTANCE_ID = ProviderInstanceId.make("copilot-test");
const THREAD_ID = ThreadId.make("copilot-v2-thread");
const LEGACY_TURN_ID = TurnId.make("copilot-turn-1");
const MODEL_SELECTION = {
  instanceId: INSTANCE_ID,
  model: "gpt-5",
} satisfies ModelSelection;
const RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeAppThread(input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: ProjectId.make("copilot-v2-project"),
    title: "Copilot V2 test",
    providerInstanceId: INSTANCE_ID,
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: THREAD_ID,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeTurnInput(input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): ProviderAdapterV2TurnInput {
  const attemptId = RunAttemptId.make("copilot-v2-attempt");
  return {
    appThread: makeAppThread(input),
    threadId: THREAD_ID,
    runId: RunId.make("copilot-v2-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId,
    rootNodeId: NodeId.make("copilot-v2-root-node"),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("copilot-v2-user-message"),
      text: "Map this turn",
      attachments: [],
    },
    modelSelection: MODEL_SELECTION,
    runtimePolicy: RUNTIME_POLICY,
  };
}

function baseEvent(input: {
  readonly type: ProviderRuntimeEvent["type"];
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
  readonly requestId?: RuntimeRequestId;
}) {
  return {
    eventId: EventId.make(`event-${input.type}`),
    provider: COPILOT_DRIVER_KIND,
    providerInstanceId: INSTANCE_ID,
    threadId: THREAD_ID,
    createdAt: "2026-07-31T12:00:00.000Z",
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  };
}

function makeLegacyAdapter(input: {
  readonly events: PubSub.PubSub<ProviderRuntimeEvent>;
  readonly approvalResponses: Array<{
    readonly requestId: string;
    readonly decision: string;
  }>;
  readonly sendTurn?: CopilotAdapterV2LegacyPort["sendTurn"];
}): CopilotAdapterV2LegacyPort {
  return {
    startSession: (startInput) =>
      Effect.succeed({
        provider: COPILOT_DRIVER_KIND,
        providerInstanceId: INSTANCE_ID,
        status: "ready",
        runtimeMode: startInput.runtimeMode,
        cwd: startInput.cwd,
        model: startInput.modelSelection?.model,
        threadId: startInput.threadId,
        resumeCursor: { sessionId: "copilot-native-thread" },
        createdAt: "2026-07-31T12:00:00.000Z",
        updatedAt: "2026-07-31T12:00:00.000Z",
      }),
    sendTurn:
      input.sendTurn ??
      ((turnInput) =>
        PubSub.publish(input.events, {
          ...baseEvent({ type: "turn.started", turnId: LEGACY_TURN_ID }),
          type: "turn.started",
          payload: { model: turnInput.modelSelection?.model },
        }).pipe(
          Effect.as({
            threadId: turnInput.threadId,
            turnId: LEGACY_TURN_ID,
          }),
        )),
    interruptTurn: () => Effect.void,
    respondToRequest: (_threadId, requestId, decision) =>
      Effect.sync(() => {
        input.approvalResponses.push({
          requestId: String(requestId),
          decision,
        });
      }),
    respondToUserInput: () => Effect.void,
    stopSession: () => Effect.void,
    hasSession: () => Effect.succeed(true),
    rollbackThread: () => Effect.succeed({ threadId: THREAD_ID, turns: [] }),
    streamEvents: Stream.fromPubSub(input.events),
  };
}

const makeRuntime = (options?: {
  readonly sendTurn?: (
    events: PubSub.PubSub<ProviderRuntimeEvent>,
  ) => CopilotAdapterV2LegacyPort["sendTurn"];
}) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const approvalResponses: Array<{ requestId: string; decision: string }> = [];
    const adapter = makeCopilotAdapterV2({
      instanceId: INSTANCE_ID,
      legacyAdapter: makeLegacyAdapter({
        events,
        approvalResponses,
        ...(options?.sendTurn ? { sendTurn: options.sendTurn(events) } : {}),
      }),
      idAllocator,
    });
    const runtime = yield* adapter.openSession({
      threadId: THREAD_ID,
      providerSessionId: ProviderSessionId.make("copilot-v2-session"),
      modelSelection: MODEL_SELECTION,
      runtimePolicy: RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId: THREAD_ID,
      modelSelection: MODEL_SELECTION,
      runtimePolicy: RUNTIME_POLICY,
    });
    const now = yield* DateTime.now;
    return {
      events,
      approvalResponses,
      runtime,
      providerThread,
      turnInput: makeTurnInput({ providerThread, now }),
    };
  });

describe("CopilotAdapterV2", () => {
  it.effect("projects native Copilot subagents without completing the parent run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRuntime();
        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === "copilot-agent-1" &&
              event.subagent.status === "completed",
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* fixture.runtime.startTurn(fixture.turnInput);
        const taskId = RuntimeTaskId.make("copilot-agent-1");
        const raw = (
          type: string,
          data: Readonly<Record<string, unknown>>,
          agentId = String(taskId),
        ) => ({
          source: "copilot.sdk.event" as const,
          method: type,
          payload: {
            id: `sdk-${type}`,
            type,
            agentId,
            timestamp: "2026-07-31T12:00:00.000Z",
            parentId: null,
            data,
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "task.started", turnId: LEGACY_TURN_ID }),
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make("copilot-shell-task"),
            description: "Run a detached command",
            taskType: "shell",
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "task.started", turnId: LEGACY_TURN_ID }),
          type: "task.started",
          raw: raw("subagent.started", {
            toolCallId: "spawn-agent-1",
            agentName: "explore",
            agentDisplayName: "Explore",
            agentDescription: "Inspect the provider mapping",
            model: "gpt-5",
          }),
          payload: {
            taskId,
            description: "Inspect the provider mapping",
            taskType: "explore",
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "task.progress", turnId: LEGACY_TURN_ID }),
          type: "task.progress",
          raw: raw("assistant.turn_start", { turnId: "child-turn-1", model: "gpt-5" }),
          payload: {
            taskId,
            description: "Inspect the provider mapping",
            summary: "Subagent turn started",
          },
        });
        const childItemId = RuntimeItemId.make("copilot-child-message");
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({
            type: "content.delta",
            turnId: LEGACY_TURN_ID,
            itemId: childItemId,
          }),
          type: "content.delta",
          raw: raw("assistant.message_delta", {
            messageId: "child-message",
            deltaContent: "Child result",
          }),
          payload: { streamKind: "assistant_text", delta: "Child result" },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({
            type: "item.completed",
            turnId: LEGACY_TURN_ID,
            itemId: childItemId,
          }),
          type: "item.completed",
          raw: raw("assistant.message", {
            turnId: "child-turn-1",
            messageId: "child-message",
            content: "Child result",
          }),
          payload: { itemType: "assistant_message", status: "completed" },
        });
        const nestedTaskId = RuntimeTaskId.make("copilot-agent-2");
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({
            type: "item.started",
            turnId: LEGACY_TURN_ID,
            itemId: RuntimeItemId.make("copilot-tool-spawn-nested-agent"),
          }),
          type: "item.started",
          raw: raw("tool.execution_start", {
            turnId: "child-turn-1",
            toolCallId: "spawn-nested-agent",
            toolName: "delegate_agent",
            arguments: { prompt: "Inspect nested behavior" },
          }),
          payload: {
            itemType: "collab_agent_tool_call",
            status: "inProgress",
            title: "delegate_agent",
            data: {
              toolCallId: "spawn-nested-agent",
              toolName: "delegate_agent",
              prompt: "Inspect nested behavior",
            },
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "task.started", turnId: LEGACY_TURN_ID }),
          type: "task.started",
          raw: raw(
            "subagent.started",
            {
              toolCallId: "spawn-nested-agent",
              agentName: "explore",
              agentDisplayName: "Nested Explore",
              agentDescription: "Inspect nested behavior",
            },
            String(nestedTaskId),
          ),
          payload: {
            taskId: nestedTaskId,
            description: "Inspect nested behavior",
            taskType: "explore",
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "task.completed", turnId: LEGACY_TURN_ID }),
          type: "task.completed",
          raw: raw(
            "subagent.completed",
            {
              toolCallId: "spawn-nested-agent",
              agentName: "explore",
              agentDisplayName: "Nested Explore",
            },
            String(nestedTaskId),
          ),
          payload: {
            taskId: nestedTaskId,
            status: "completed",
            summary: "Nested exploration complete",
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "task.progress", turnId: LEGACY_TURN_ID }),
          type: "task.progress",
          raw: raw("assistant.turn_end", { turnId: "child-turn-1", model: "gpt-5" }),
          payload: {
            taskId,
            description: "Inspect the provider mapping",
            summary: "Subagent turn completed",
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "task.completed", turnId: LEGACY_TURN_ID }),
          type: "task.completed",
          raw: raw("subagent.completed", {
            toolCallId: "spawn-agent-1",
            agentName: "explore",
            agentDisplayName: "Explore",
          }),
          payload: { taskId, status: "completed", summary: "Exploration complete" },
        });

        const collected = Array.from(yield* Fiber.join(collectedFiber));
        const createdThreads = collected
          .filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "app_thread.created" }> =>
              event.type === "app_thread.created",
          )
          .map((event) => event.appThread);
        assert.lengthOf(createdThreads, 2);
        const childThread = createdThreads.find(
          (thread) => thread.lineage.parentThreadId === THREAD_ID,
        );
        assert.isDefined(childThread);
        assert.equal(childThread?.lineage.parentThreadId, THREAD_ID);
        assert.equal(childThread?.lineage.relationshipToParent, "subagent");
        assert.isNull(childThread?.activeProviderThreadId);
        const nestedChildThread = createdThreads.find(
          (thread) => thread.lineage.parentThreadId === childThread?.id,
        );
        assert.isDefined(nestedChildThread);
        assert.equal(nestedChildThread?.lineage.relationshipToParent, "subagent");
        assert.isNull(nestedChildThread?.activeProviderThreadId);
        const completedSubagent = collected.findLast(
          (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
            event.type === "subagent.updated",
        )?.subagent;
        assert.equal(completedSubagent?.status, "completed");
        assert.equal(completedSubagent?.childThreadId, childThread?.id);
        const childProviderThread = collected.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_thread.updated" }> =>
            event.type === "provider_thread.updated" &&
            event.providerThread.id === completedSubagent?.providerThreadId,
        )?.providerThread;
        assert.isNull(childProviderThread?.appThreadId);
        assert.equal(
          childProviderThread?.nativeThreadRef?.nativeId,
          "copilot-subagent:copilot-agent-1",
        );
        const childMessage = collected.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
            event.type === "message.updated" && event.message.text === "Child result",
        )?.message;
        assert.equal(childMessage?.threadId, childThread?.id);
        const childProviderTurn = collected.findLast(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated" && event.threadId === childThread?.id,
        )?.providerTurn;
        assert.equal(childProviderTurn?.status, "completed");
        assert.equal(childProviderTurn?.nativeTurnRef?.nativeId, "copilot-agent-1:child-turn-1");
        assert.equal(
          collected.some((event) => event.type === "turn.terminal"),
          false,
        );

        const terminalFiber = yield* fixture.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        const finalItemId = RuntimeItemId.make("copilot-root-final-summary");
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({
            type: "content.delta",
            turnId: LEGACY_TURN_ID,
            itemId: finalItemId,
          }),
          type: "content.delta",
          raw: raw(
            "assistant.message_delta",
            {
              messageId: "root-final-summary",
              deltaContent: "Final summary after subagents.",
            },
            "",
          ),
          payload: { streamKind: "assistant_text", delta: "Final summary after subagents." },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({
            type: "item.completed",
            turnId: LEGACY_TURN_ID,
            itemId: finalItemId,
          }),
          type: "item.completed",
          raw: raw(
            "assistant.message",
            {
              turnId: "root-final-turn",
              messageId: "root-final-summary",
              content: "Final summary after subagents.",
            },
            "",
          ),
          payload: { itemType: "assistant_message", status: "completed" },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "turn.completed", turnId: LEGACY_TURN_ID }),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        const terminalEvents = Array.from(yield* Fiber.join(terminalFiber));
        const finalSummary = terminalEvents.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
            event.type === "message.updated" &&
            event.message.text === "Final summary after subagents.",
        );
        assert.isDefined(finalSummary);
        assert.equal(finalSummary?.message.threadId, THREAD_ID);
        assert.equal(terminalEvents.filter((event) => event.type === "turn.terminal").length, 1);
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("maps assistant streaming, tools, and terminal turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRuntime();
        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.take(12),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* fixture.runtime.startTurn(fixture.turnInput);
        const itemId = RuntimeItemId.make("copilot-command-item");
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({
            type: "content.delta",
            turnId: LEGACY_TURN_ID,
            itemId: RuntimeItemId.make("copilot-assistant-item"),
          }),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "Hello from Copilot" },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "item.started", turnId: LEGACY_TURN_ID, itemId }),
          type: "item.started",
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            title: "Run tests",
            data: { command: "vp test run" },
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "item.completed", turnId: LEGACY_TURN_ID, itemId }),
          type: "item.completed",
          payload: {
            itemType: "command_execution",
            status: "completed",
            title: "Run tests",
            detail: "All tests passed",
            data: { command: "vp test run", exitCode: 0 },
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "turn.completed", turnId: LEGACY_TURN_ID }),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        const collected = Array.from(yield* Fiber.join(collectedFiber));

        const messages = collected.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
            event.type === "message.updated",
        );
        assert.equal(messages.at(-1)?.message.text, "Hello from Copilot");
        const commandEvent = collected.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "completed",
        );
        assert.isTrue(
          commandEvent?.type === "turn_item.updated" &&
            commandEvent.turnItem.type === "command_execution",
        );
        if (
          commandEvent?.type === "turn_item.updated" &&
          commandEvent.turnItem.type === "command_execution"
        ) {
          assert.equal(commandEvent.turnItem.status, "completed");
          assert.equal(commandEvent.turnItem.output, "All tests passed");
        }
        const terminal = collected.find((event) => event.type === "turn.terminal");
        assert.equal(terminal?.status, "completed");
        const providerThreads = collected
          .filter(
            (
              event,
            ): event is Extract<ProviderAdapterV2Event, { type: "provider_thread.updated" }> =>
              event.type === "provider_thread.updated",
          )
          .map((event) => event.providerThread);
        assert.deepEqual(
          providerThreads.map((thread) => thread.status),
          ["active", "idle"],
        );
        assert.equal(providerThreads.at(-1)?.firstRunOrdinal, 1);
        assert.equal(providerThreads.at(-1)?.lastRunOrdinal, 1);
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("preserves streamed assistant text when the item completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRuntime();
        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.take(11),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* fixture.runtime.startTurn(fixture.turnInput);
        const itemId = RuntimeItemId.make("copilot-streamed-assistant-item");
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "item.started", turnId: LEGACY_TURN_ID, itemId }),
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "content.delta", turnId: LEGACY_TURN_ID, itemId }),
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: "I found the issue.",
          },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "item.completed", turnId: LEGACY_TURN_ID, itemId }),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
          },
        });
        const collected = Array.from(yield* Fiber.join(collectedFiber));

        const completedItem = collected.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.status === "completed",
        );
        assert.isTrue(
          completedItem?.type === "turn_item.updated" &&
            completedItem.turnItem.type === "assistant_message",
        );
        if (
          completedItem?.type === "turn_item.updated" &&
          completedItem.turnItem.type === "assistant_message"
        ) {
          assert.equal(completedItem.turnItem.text, "I found the issue.");
          assert.isFalse(completedItem.turnItem.streaming);
        }
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("maps approvals and routes responses to the legacy adapter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRuntime();
        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.take(5),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* fixture.runtime.startTurn(fixture.turnInput);
        const legacyRequestId = RuntimeRequestId.make("copilot-approval");
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({
            type: "request.opened",
            turnId: LEGACY_TURN_ID,
            requestId: legacyRequestId,
          }),
          type: "request.opened",
          payload: {
            requestType: "command_execution_approval",
            detail: "Allow command?",
            args: { command: "git status" },
          },
        });
        const collected = Array.from(yield* Fiber.join(collectedFiber));
        const requestEvent = collected.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "runtime_request.updated" }> =>
            event.type === "runtime_request.updated",
        );
        assert.equal(requestEvent?.runtimeRequest.kind, "command");
        assert.equal(requestEvent?.runtimeRequest.status, "pending");
        if (!requestEvent) {
          return yield* Effect.die("Expected a mapped Copilot runtime request.");
        }
        yield* fixture.runtime.respondToRuntimeRequest({
          requestId: requestEvent.runtimeRequest.id,
          decision: "accept",
        });
        assert.deepEqual(fixture.approvalResponses, [
          { requestId: "copilot-approval", decision: "accept" },
        ]);
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("keeps structured user input attached to its provider turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRuntime();
        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.take(5),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* fixture.runtime.startTurn(fixture.turnInput);
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({
            type: "user-input.requested",
            turnId: LEGACY_TURN_ID,
            requestId: RuntimeRequestId.make("copilot-user-input"),
          }),
          type: "user-input.requested",
          payload: {
            questions: [
              {
                id: "answer",
                header: "Input",
                question: "How should Copilot continue?",
                options: [{ label: "Continue", description: "Continue" }],
              },
            ],
          },
        });
        const collected = Array.from(yield* Fiber.join(collectedFiber));
        const requestEvent = collected.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "runtime_request.updated" }> =>
            event.type === "runtime_request.updated",
        );
        assert.isNotNull(requestEvent?.runtimeRequest.providerTurnId ?? null);
        assert.isTrue(
          collected.some(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
          ),
        );
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("maps proposed plans into V2 plan artifacts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRuntime();
        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.take(4),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* fixture.runtime.startTurn(fixture.turnInput);
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "turn.proposed.completed", turnId: LEGACY_TURN_ID }),
          type: "turn.proposed.completed",
          payload: { planMarkdown: "1. Update the adapter\n2. Run tests" },
        });
        const collected = Array.from(yield* Fiber.join(collectedFiber));
        const planEvent = collected.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "plan.updated" }> =>
            event.type === "plan.updated",
        );
        assert.equal(planEvent?.plan.kind, "proposed_plan");
        assert.equal(
          planEvent?.plan.kind === "proposed_plan" ? planEvent.plan.markdown : undefined,
          "1. Update the adapter\n2. Run tests",
        );
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("removes failed starts before correlating the next provider turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        const nextTurnId = TurnId.make("copilot-turn-after-failure");
        const fixture = yield* makeRuntime({
          sendTurn: (events) => (input) => {
            attempts += 1;
            if (attempts === 1) {
              return Effect.fail(
                new CopilotAdapterValidationError({
                  provider: COPILOT_DRIVER_KIND,
                  operation: "sendTurn",
                  issue: "Rejected before creating a provider turn.",
                }),
              );
            }
            return PubSub.publish(events, {
              ...baseEvent({ type: "turn.started", turnId: nextTurnId }),
              type: "turn.started",
              payload: { model: input.modelSelection?.model },
            }).pipe(Effect.as({ threadId: input.threadId, turnId: nextTurnId }));
          },
        });
        const firstExit = yield* fixture.runtime.startTurn(fixture.turnInput).pipe(Effect.exit);
        assert.equal(firstExit._tag, "Failure");

        const nextRootNodeId = NodeId.make("copilot-v2-next-root");
        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* fixture.runtime.startTurn({
          ...fixture.turnInput,
          runId: RunId.make("copilot-v2-next-run"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("copilot-v2-next-attempt"),
          rootNodeId: nextRootNodeId,
        });
        const event = Array.from(yield* Fiber.join(collectedFiber)).find(
          (candidate) => candidate.type === "provider_turn.updated",
        );
        assert.equal(event?.type, "provider_turn.updated");
        if (event?.type === "provider_turn.updated") {
          assert.equal(event.providerTurn.nodeId, nextRootNodeId);
          assert.equal(event.providerTurn.ordinal, 2);
        }
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("removes accepted queued starts before later turn events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let attempts = 0;
        const queuedTurnId = TurnId.make("copilot-queued-turn");
        const nextTurnId = TurnId.make("copilot-turn-after-queue");
        const fixture = yield* makeRuntime({
          sendTurn: (events) => (input) => {
            attempts += 1;
            if (attempts === 1) {
              return Effect.succeed({ threadId: input.threadId, turnId: queuedTurnId });
            }
            return PubSub.publish(events, {
              ...baseEvent({ type: "turn.started", turnId: nextTurnId }),
              type: "turn.started",
              payload: { model: input.modelSelection?.model },
            }).pipe(Effect.as({ threadId: input.threadId, turnId: nextTurnId }));
          },
        });
        yield* fixture.runtime.startTurn(fixture.turnInput);

        const nextRootNodeId = NodeId.make("copilot-v2-after-queue-root");
        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.take(7),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "turn.started", turnId: queuedTurnId }),
          type: "turn.started",
          payload: { model: MODEL_SELECTION.model },
        });
        yield* PubSub.publish(fixture.events, {
          ...baseEvent({ type: "turn.completed", turnId: queuedTurnId }),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        yield* fixture.runtime.startTurn({
          ...fixture.turnInput,
          runId: RunId.make("copilot-v2-after-queue-run"),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("copilot-v2-after-queue-attempt"),
          rootNodeId: nextRootNodeId,
        });
        const collected = Array.from(yield* Fiber.join(collectedFiber));
        const queuedTurnUpdates = collected.filter(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === queuedTurnId,
        );
        assert.equal(queuedTurnUpdates.length, 2);
        if (
          queuedTurnUpdates[0]?.type === "provider_turn.updated" &&
          queuedTurnUpdates[1]?.type === "provider_turn.updated"
        ) {
          assert.deepEqual(
            queuedTurnUpdates[1].providerTurn.startedAt,
            queuedTurnUpdates[0].providerTurn.startedAt,
          );
        }
        const providerTurn = collected.find(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === nextTurnId,
        );
        assert.equal(providerTurn?.type, "provider_turn.updated");
        if (providerTurn?.type === "provider_turn.updated") {
          assert.equal(providerTurn.providerTurn.nodeId, nextRootNodeId);
          assert.equal(providerTurn.providerTurn.ordinal, 2);
        }
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("reattaches resumed threads for event routing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resumedThreadId = ThreadId.make("copilot-v2-resumed-thread");
        const resumedTurnId = TurnId.make("copilot-v2-resumed-turn");
        const fixture = yield* makeRuntime({
          sendTurn: (events) => (input) =>
            PubSub.publish(events, {
              ...baseEvent({ type: "turn.started", turnId: resumedTurnId }),
              threadId: input.threadId,
              type: "turn.started",
              payload: { model: input.modelSelection?.model },
            }).pipe(Effect.as({ threadId: input.threadId, turnId: resumedTurnId })),
        });
        const providerThread = yield* fixture.runtime.resumeThread({
          providerThread: fixture.providerThread,
          threadId: resumedThreadId,
          modelSelection: MODEL_SELECTION,
          runtimePolicy: RUNTIME_POLICY,
        });
        assert.equal(providerThread.appThreadId, resumedThreadId);

        const collectedFiber = yield* fixture.runtime.events.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* fixture.runtime.startTurn({
          ...fixture.turnInput,
          appThread: {
            ...fixture.turnInput.appThread,
            id: resumedThreadId,
            lineage: {
              ...fixture.turnInput.appThread.lineage,
              rootThreadId: resumedThreadId,
            },
            activeProviderThreadId: providerThread.id,
          },
          threadId: resumedThreadId,
          providerThread,
        });
        const event = Array.from(yield* Fiber.join(collectedFiber)).find(
          (candidate) => candidate.type === "provider_turn.updated",
        );
        assert.equal(event?.type, "provider_turn.updated");
        if (event?.type === "provider_turn.updated") {
          assert.equal(event.threadId, resumedThreadId);
        }
      }),
    ).pipe(Effect.provide(idAllocatorLayer)),
  );
});
