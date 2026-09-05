import {
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { TurnProcessingQuiescedReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import type { MeasuredWsClient } from "./NetworkTransferMeasurement.integration.ts";
import type { OrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import {
  expectedRecordedAssistantText,
  makeRecordedTransferTurn,
  TRANSFER_HISTORY_TURN_COUNT,
} from "./fixtures/transferBudget.ts";

export const TRANSFER_PROJECT_ID = ProjectId.make("transfer-budget-project");
export const TRANSFER_THREAD_ID = ThreadId.make("transfer-budget-thread");
export const TRANSFER_MEASURED_TURN_INDEX = TRANSFER_HISTORY_TURN_COUNT;

export function transferModelSelection(provider: ProviderDriverKind) {
  return {
    instanceId: defaultInstanceIdForDriver(provider),
    model: DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL,
  };
}

function turnTimestamp(turnIndex: number): string {
  return `2026-06-01T00:${String(turnIndex).padStart(2, "0")}:00.000Z`;
}

export const TRANSFER_MEASURED_TURN_CREATED_AT = turnTimestamp(TRANSFER_MEASURED_TURN_INDEX);

const waitForTurnQuiesced = Effect.fn("TransferBudget.waitForTurnQuiesced")(function* (
  harness: OrchestrationIntegrationHarness,
  checkpointTurnCount: number,
) {
  const receipt = yield* harness.waitForReceipt(
    (receipt): receipt is TurnProcessingQuiescedReceipt =>
      receipt.type === "turn.processing.quiesced" &&
      receipt.threadId === TRANSFER_THREAD_ID &&
      receipt.checkpointTurnCount === checkpointTurnCount,
  );
  yield* harness.drainProviderRuntime;
  yield* harness.drainCheckpointReactor;
  return receipt;
});

export const seedTransferBudgetHistory = Effect.fn("TransferBudget.seedHistory")(function* (
  harness: OrchestrationIntegrationHarness,
  provider: ProviderDriverKind,
) {
  if (!harness.adapterHarness) {
    return yield* Effect.die(new Error("Transfer budget history requires the replay adapter."));
  }

  const modelSelection = transferModelSelection(provider);
  yield* harness.engine.dispatch({
    type: "project.create",
    commandId: CommandId.make(`transfer:${provider}:project-create`),
    projectId: TRANSFER_PROJECT_ID,
    title: "Transfer Budget Project",
    workspaceRoot: harness.workspaceDir,
    defaultModelSelection: modelSelection,
    createdAt: turnTimestamp(0),
  });
  yield* harness.engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`transfer:${provider}:thread-create`),
    threadId: TRANSFER_THREAD_ID,
    projectId: TRANSFER_PROJECT_ID,
    title: `${provider} transfer history`,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "main",
    worktreePath: harness.workspaceDir,
    createdAt: turnTimestamp(0),
  });

  for (let turnIndex = 0; turnIndex < TRANSFER_HISTORY_TURN_COUNT; turnIndex += 1) {
    const response = makeRecordedTransferTurn(provider, turnIndex);
    if (turnIndex === 0) {
      yield* harness.adapterHarness.queueTurnResponseForNextSession(response);
    } else {
      yield* harness.adapterHarness.queueTurnResponse(TRANSFER_THREAD_ID, response);
    }

    yield* harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`transfer:${provider}:turn:${turnIndex + 1}`),
      threadId: TRANSFER_THREAD_ID,
      message: {
        messageId: MessageId.make(`transfer-user-${turnIndex + 1}`),
        role: "user",
        text: `Inspect transfer behavior for historical turn ${turnIndex + 1}.`,
        attachments: [],
      },
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: turnTimestamp(turnIndex),
    });
    yield* waitForTurnQuiesced(harness, turnIndex + 1);
  }
});

export const queueMeasuredTransferTurn = Effect.fn("TransferBudget.queueMeasuredTurn")(function* (
  harness: OrchestrationIntegrationHarness,
  provider: ProviderDriverKind,
) {
  if (!harness.adapterHarness) {
    return yield* Effect.die(new Error("Transfer budget measurement requires the replay adapter."));
  }
  const response = makeRecordedTransferTurn(provider, TRANSFER_MEASURED_TURN_INDEX);
  yield* harness.adapterHarness.queueTurnResponse(TRANSFER_THREAD_ID, response);
});

export function expectedMeasuredAssistantText(provider: ProviderDriverKind): string {
  return expectedRecordedAssistantText(provider, TRANSFER_MEASURED_TURN_INDEX);
}

/** Takes from the queue until one value matches, and returns everything taken. */
export const collectQueueUntil = Effect.fn("TransferBudget.collectQueueUntil")(function* <A>(
  queue: Queue.Queue<A>,
  predicate: (value: A) => boolean,
  waitDescription: string,
) {
  return yield* Effect.gen(function* () {
    const values: A[] = [];
    while (true) {
      const value = yield* Queue.take(queue);
      values.push(value);
      if (predicate(value)) return values;
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${waitDescription}`)),
    }),
  );
});

/**
 * Resumes the thread subscription from a cursor on a measured client. The
 * consumer runs in the client's scope, so closing the client stops it. Callers
 * read items from the returned queue.
 */
export const subscribeThreadItems = Effect.fn("TransferBudget.subscribeThreadItems")(function* (
  measured: MeasuredWsClient,
  afterSequence: number,
) {
  const items = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
  yield* measured.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
    threadId: TRANSFER_THREAD_ID,
    afterSequence,
    requestCompletionMarker: true,
  }).pipe(
    Stream.runForEach((item) => Queue.offer(items, item).pipe(Effect.asVoid)),
    Scope.provide(measured.scope),
    Effect.forkIn(measured.scope),
  );
  return items;
});

/** Shell counterpart of subscribeThreadItems. */
export const subscribeShellItems = Effect.fn("TransferBudget.subscribeShellItems")(function* (
  measured: MeasuredWsClient,
  afterSequence: number,
) {
  const items = yield* Queue.unbounded<OrchestrationShellStreamItem>();
  yield* measured.client[ORCHESTRATION_WS_METHODS.subscribeShell]({
    afterSequence,
    requestCompletionMarker: true,
  }).pipe(
    Stream.runForEach((item) => Queue.offer(items, item).pipe(Effect.asVoid)),
    Scope.provide(measured.scope),
    Effect.forkIn(measured.scope),
  );
  return items;
});

/** Waits for the initial catch-up and reports whether it was a replay or a snapshot reset. */
export const awaitSubscriptionSynchronized = Effect.fn(
  "TransferBudget.awaitSubscriptionSynchronized",
)(function* <Item extends OrchestrationThreadStreamItem | OrchestrationShellStreamItem>(
  items: Queue.Queue<Item>,
  waitDescription: string,
) {
  const initial = yield* collectQueueUntil(
    items,
    (item) => item.kind === "synchronized",
    waitDescription,
  );
  return initial.some((item) => item.kind === "snapshot")
    ? ("snapshot" as const)
    : ("replay" as const);
});

export { TRANSFER_HISTORY_TURN_COUNT, waitForTurnQuiesced };
