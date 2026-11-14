import { modelSelectionsEqual } from "@t3tools/shared/model";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  isCompactionCommandMessage,
  parseGoalCommand,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs, withInlineContext } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ContextHandoffBackgroundWorkError,
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

import type { ProviderTurnStartRunControlsShape, ProviderTurnStartRunStart } from "./ProviderTurnStartService-part2.ts";
import type { ProviderTurnStartHandoffContext } from "./ProviderTurnStartService-part4.ts";
import { refusedBeforePrompt } from "./ProviderTurnStartService-part2.ts";
import type { ProviderTurnStartContext } from "./ProviderTurnStartService-part3.ts";

export const makeTurnStarter = Effect.fn("ProviderTurnStartService.makeTurnStarter")(function* (
  deps: {
    readonly context: ProviderTurnStartContext;
    readonly session: ProviderAdapter.ProviderAdapterV2SessionRuntime;
    readonly start: ProviderTurnStartRunStart;
    readonly effectiveHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly retryHandoff: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly runningProviderThread: OrchestrationV2ProviderThread;
    readonly budget: ProviderTurnStartHandoffContext["budget"];
    readonly deliveredItemIds: ProviderTurnStartHandoffContext["deliveredItemIds"];
    readonly goalCommand: boolean;
    readonly sideChatHandoff: OrchestrationV2ContextHandoff | undefined;
    readonly restartNote: string;
    readonly noteContinuation: boolean;
    readonly userText: string;
    readonly isCurrentAttemptInStatus: ProviderTurnStartRunControlsShape["isCurrentAttemptInStatus"];
  },
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const { projection, run, providerThread } = deps.context;
  const { session, start, runningProviderThread, budget, deliveredItemIds } = deps;
  const { effectiveHandoffs, retryHandoff, goalCommand, sideChatHandoff } = deps;
  const { restartNote, noteContinuation, userText, isCurrentAttemptInStatus } = deps;

      const persistHandoff = Effect.fn("ProviderTurnStartService.persist")(function* (
        handoff: OrchestrationV2ContextHandoff,
      ) {
        const updatedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({
                threadId: projection.thread.id,
              }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, updatedAt },
            },
          ],
        });
      });
      const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
        function* (turnInput: Parameters<typeof session.startTurn>[0], compact = false) {
          const delivery = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...retryHandoff],
            deferInline: compact || goalCommand,
            providerThread: runningProviderThread,
            budget,
            alreadyDeliveredItemIds: deliveredItemIds,
            ...(session.injectHistory === undefined
              ? {}
              : {
                  inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                    session.injectHistory!({
                      providerThread: runningProviderThread,
                      ...history,
                    }),
                }),
            persist: persistHandoff,
          });
          if (!(yield* isCurrentAttemptInStatus("running"))) return;
          const start = compact ? session.compactThread! : session.startTurn;
          // Like history, the side chat context waits for a turn that sends a prompt.
          const sideChatContext =
            sideChatHandoff === undefined || compact || goalCommand
              ? ""
              : sideChatHandoff.summaryText;
          const context = [delivery.context, sideChatContext, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* start({
            ...(noteContinuation ? promptedInput : turnInput),
            message: {
              ...turnInput.message,
              text: goalCommand ? userText : withInlineContext(context, userText),
            },
          }).pipe(
            // Clear pending handoff markers for refused prompts so the next turn retains the native session.
            Effect.tapError((error) =>
              refusedBeforePrompt(error)
                ? delivery.unsent.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Failed to restore unsent context handoffs", {
                        runId: run.id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
          // After provider acceptance, failed delivery bookkeeping must not stop live ingestion.
          const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
          yield* Effect.forEach(
            [
              delivery.delivered,
              ...(sideChatContext === "" || sideChatHandoff === undefined || nativeThreadId == null
                ? []
                : [
                    persistHandoff({
                      ...sideChatHandoff,
                      toProviderThreadId: runningProviderThread.id,
                      delivery: { nativeThreadId, status: "inline" as const, itemIds: [] },
                    }),
                  ]),
            ],
            (record) =>
              record.pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("Failed to record accepted context handoff delivery", {
                    runId: run.id,
                    deliveryStatus: "pending",
                  }),
                ),
              ),
            { discard: true },
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterTurnStartError"
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId: run.id,
                cause,
              }),
        ),
      );

  return { persistHandoff, startWithHandoffs } as const;
});

export type ProviderTurnStartStarterShape = Effect.Success<ReturnType<typeof makeTurnStarter>>;
