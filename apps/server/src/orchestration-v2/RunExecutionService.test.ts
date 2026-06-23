import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import { ProviderEventIngestorV2 } from "./ProviderEventIngestor.ts";
import {
  finalProviderThreadStatus,
  layer as runExecutionServiceLayer,
  makeProviderEventRoutingState,
  type ProviderEventRouteIdentity,
  routeProviderEvent,
  RunExecutionServiceV2,
} from "./RunExecutionService.ts";

const driver = ProviderDriverKind.make("codex");

const RunExecutionTestLayer = runExecutionServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      Layer.mock(EventSinkV2)({}),
      idAllocatorLayer,
      Layer.mock(ProviderEventIngestorV2)({ ingestNormalized: () => Effect.succeed([]) }),
      ServerSettingsService.layerTest(),
    ),
  ),
);

it("keeps recoverable turn failures reusable and reserves error for broken threads", () => {
  assert.equal(finalProviderThreadStatus("reusable"), "idle");
  assert.equal(finalProviderThreadStatus("broken"), "error");
});

it.effect("routes shared-runtime events only to their owning root run", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const first: ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:first"),
      runId: RunId.make("run:shared-runtime:first"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:first"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:first"),
    };
    const second: ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:second"),
      runId: RunId.make("run:shared-runtime:second"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:second"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:second"),
    };
    const firstTurnId = ProviderTurnId.make("provider-turn:shared-runtime:first");
    const turnEvent: ProviderAdapterV2Event = {
      type: "provider_turn.updated",
      driver,
      threadId: first.threadId,
      providerTurn: {
        id: firstTurnId,
        providerThreadId: first.providerThreadId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        runAttemptId: first.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    };
    const messageEvent: ProviderAdapterV2Event = {
      type: "message.updated",
      driver,
      message: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make("message:shared-runtime:first"),
        threadId: first.threadId,
        runId: first.runId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        role: "assistant",
        text: "first only",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    };
    const terminalEvent: ProviderAdapterV2Event = {
      type: "turn.terminal",
      driver,
      providerThreadId: first.providerThreadId,
      providerTurnId: firstTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    };

    const firstInitial = makeProviderEventRoutingState({
      identity: first,
      providerTurnId: null,
    });
    const secondInitial = makeProviderEventRoutingState({
      identity: second,
      providerTurnId: null,
    });
    const [firstTurnAccepted, firstAfterTurn] = routeProviderEvent(turnEvent, first, firstInitial);
    const [secondTurnAccepted, secondAfterTurn] = routeProviderEvent(
      turnEvent,
      second,
      secondInitial,
    );

    assert.isTrue(firstTurnAccepted);
    assert.isFalse(secondTurnAccepted);
    assert.isTrue(routeProviderEvent(messageEvent, first, firstAfterTurn)[0]);
    assert.isFalse(routeProviderEvent(messageEvent, second, secondAfterTurn)[0]);
    assert.isTrue(routeProviderEvent(terminalEvent, first, firstAfterTurn)[0]);
    assert.isFalse(routeProviderEvent(terminalEvent, second, secondAfterTurn)[0]);
  }),
);

it("does not route a superseded attempt through a reused provider thread", () => {
  const threadId = ThreadId.make("thread:shared-runtime:restart");
  const providerThreadId = ProviderThreadId.make("provider-thread:shared-runtime:restart");
  const oldAttempt: ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:shared-runtime:restart"),
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:old"),
    providerThreadId,
  };
  const newAttempt: ProviderEventRouteIdentity = {
    ...oldAttempt,
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:new"),
  };
  const oldTurnEvent: ProviderAdapterV2Event = {
    type: "provider_turn.updated",
    driver,
    threadId,
    providerTurn: {
      id: ProviderTurnId.make("provider-turn:shared-runtime:restart:old"),
      providerThreadId,
      nodeId: NodeId.make("node:shared-runtime:restart:old"),
      runAttemptId: oldAttempt.attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "interrupted",
      startedAt: null,
      completedAt: null,
    },
  };

  const newState = makeProviderEventRoutingState({ identity: newAttempt, providerTurnId: null });
  assert.isFalse(routeProviderEvent(oldTurnEvent, newAttempt, newState)[0]);
});

it.effect("rechecks run ownership immediately before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionServiceV2;
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const threadId = ThreadId.make("thread:run-execution-start-guard");
    const runId = RunId.make("run:run-execution-start-guard");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-start-guard");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-start-guard");
    const rootNodeId = NodeId.make("node:run-execution-start-guard");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
    } as OrchestrationV2Run;
    const rootNode = { id: rootNodeId } as OrchestrationV2ExecutionNode;
    const providerThread = {
      id: providerThreadId,
      driver,
    } as OrchestrationV2ProviderThread;
    const attempt = {
      id: attemptId,
      providerTurnId: null,
    } as OrchestrationV2RunAttempt;
    const session = {
      events: Stream.never,
      startTurn: () => Ref.update(providerStarts, (count) => count + 1),
    } as unknown as ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-start-guard"),
      appThread: { id: threadId } as OrchestrationV2AppThread,
      providerSessionId,
      session,
      run,
      rootNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard"),
      } as OrchestrationV2CheckpointScope,
      providerThread,
      attempt,
      attemptId,
      providerTurnOrdinal: 1,
      shouldStartProviderTurn: () =>
        Ref.modify(guardCalls, (calls) => [calls === 0, calls + 1] as const),
      message: {
        messageId: MessageId.make("message:run-execution-start-guard"),
        text: "Do not start after ownership changes.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    });

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
  }).pipe(Effect.provide(RunExecutionTestLayer)),
);
