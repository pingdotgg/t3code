import {
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2Shape,
} from "@t3tools/provider-core/server/ProviderAdapter";

/** A turn the adapter was asked to run: its thread and the text the provider got. */
export interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
}

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

const unimplemented = (detail: string) =>
  Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));

/**
 * A Codex-shaped adapter that records every turn's input text and completes
 * each turn at once with `response`. For tests of what a provider is sent.
 */
export const makeCapturingCodexAdapter = (
  capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>,
  options: {
    readonly response: string;
    readonly modelSelection: ModelSelection;
    /** Holds each turn open until this completes, so a test can act mid-turn. */
    readonly holdTurn?: Effect.Effect<void>;
  },
) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: options.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const providerTurnUpdate = (
          turnInput: ProviderAdapterV2TurnInput,
          status: "running" | "completed",
          startedAt: DateTime.Utc,
          completedAt: DateTime.Utc | null,
        ): ProviderAdapterV2Event => ({
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            id: ProviderTurnId.make(`provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`),
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: {
              driver,
              nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              strength: "strong",
            },
            ordinal: turnInput.runOrdinal,
            status,
            startedAt,
            completedAt,
          },
        });
        const finishTurn = (turnInput: ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            const eventTime = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(
              `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
            );
            yield* PubSub.publishAll(events, [
              providerTurnUpdate(turnInput, "completed", eventTime, eventTime),
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(
                    `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                  ),
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turnInput.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: eventTime,
                  completedAt: eventTime,
                  updatedAt: eventTime,
                  type: "assistant_message",
                  messageId: MessageId.make(
                    `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                  ),
                  text: options.response,
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ] satisfies ReadonlyArray<ProviderAdapterV2Event>);
          });
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(capturedTurns, (turns) => [
                ...turns,
                {
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                },
              ]);
              if (options.holdTurn !== undefined) {
                // Ends the turn later, as a live provider does; startTurn returns now.
                // Until then the turn is running, so Stop and steering can target it.
                yield* PubSub.publish(
                  events,
                  providerTurnUpdate(turnInput, "running", yield* DateTime.now, null),
                );
                yield* Effect.forkDetach(
                  options.holdTurn.pipe(Effect.andThen(finishTurn(turnInput))),
                );
                return;
              }
              yield* finishTurn(turnInput);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused in this test"),
          rollbackThread: () => unimplemented("rollbackThread unused in this test"),
          forkThread: () => unimplemented("forkThread unused in this test"),
        };
      }),
  }) satisfies ProviderAdapterV2Shape;
