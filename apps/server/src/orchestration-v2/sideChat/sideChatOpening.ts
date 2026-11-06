import {
  type CommandId,
  ContextHandoffId,
  type NodeId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2Run,
  type OrchestrationV2SideChat,
  type OrchestrationV2SideChatOpening,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type RunId,
  SIDE_CHAT_CONTEXT_FALLBACK_HANDOFF_TITLE,
  SIDE_CHAT_CONTEXT_HANDOFF_TITLE,
  SIDE_CHAT_SUMMARY_HANDOFF_TITLE,
  SIDE_CHAT_OPENING_WAIT_CAP_MS,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";
import { buildSideChatLateSummaryText, readySideChatSummary } from "./sideChatText.ts";

/** The outbox id of a side chat's opening summary. The open command's id is its request id. */
export function sideChatOpeningEffectId(requestId: string): string {
  return `effect:${requestId}:side-chat.opening`;
}

/** Writes the opening summary of the side chat that `commandId` opened. */
export function pendingSideChatOpeningEffect(
  commandId: CommandId,
  threadId: ThreadId,
): PendingOrchestrationEffectV2 {
  return {
    id: sideChatOpeningEffectId(commandId),
    commandId,
    threadId,
    request: { type: "side-chat.opening" },
  };
}

/** Waits at most `SIDE_CHAT_OPENING_WAIT_CAP_MS` for `settled`; `true` when it finished in time. */
export function awaitWithinSideChatWaitCap<E>(
  settled: Effect.Effect<void, E>,
): Effect.Effect<boolean, E> {
  return settled.pipe(
    Effect.timeoutOption(SIDE_CHAT_OPENING_WAIT_CAP_MS),
    Effect.map(Option.isSome),
  );
}

/** The opening context handed to the provider thread that `runId` starts fresh. */
export function sideChatOpeningHandoffId(runId: RunId): ContextHandoffId {
  return ContextHandoffId.make(`side-chat-opening:${runId}`);
}

/** Whether `handoff` is the opening context some run of a side chat received. */
export function isSideChatOpeningHandoff(
  handoff: Pick<OrchestrationV2ContextHandoff, "id" | "targetRunId">,
): boolean {
  return handoff.id === sideChatOpeningHandoffId(handoff.targetRunId);
}

/** The lesson summary handed to `runId` because it missed the opening context. */
export function sideChatLateSummaryHandoffId(runId: RunId): ContextHandoffId {
  return ContextHandoffId.make(`side-chat-late-summary:${runId}`);
}

/** Whether `handoff` is a lesson summary that some run of a side chat received late. */
export function isSideChatLateSummaryHandoff(
  handoff: Pick<OrchestrationV2ContextHandoff, "id" | "targetRunId">,
): boolean {
  return handoff.id === sideChatLateSummaryHandoffId(handoff.targetRunId);
}

/**
 * The lesson summary still owed to a side chat whose opening context went out without it, or null:
 * no context went out yet (it will carry the summary), the summary is not ready, or a handoff
 * already carried its text. The text is the record, so a summary is sent at most once.
 */
export function owedSideChatSummary(
  opening: OrchestrationV2SideChatOpening,
  contextHandoffs: ReadonlyArray<
    Pick<OrchestrationV2ContextHandoff, "id" | "targetRunId" | "summaryText">
  >,
): string | null {
  const summary = readySideChatSummary(opening);
  if (summary === null || !contextHandoffs.some(isSideChatOpeningHandoff)) return null;
  return contextHandoffs.some((handoff) => handoff.summaryText.includes(summary)) ? null : summary;
}

/**
 * Whether an opening context sent to `providerThreadId` carries the lesson summary. Such an opening
 * went to a fresh native thread after any late summary was written, so it makes them redundant.
 */
export function sideChatOpeningCarriesSummary(
  opening: OrchestrationV2SideChatOpening,
  contextHandoffs: ReadonlyArray<
    Pick<OrchestrationV2ContextHandoff, "id" | "targetRunId" | "toProviderThreadId" | "summaryText">
  >,
  providerThreadId: ProviderThreadId,
): boolean {
  const summary = readySideChatSummary(opening);
  return (
    summary !== null &&
    contextHandoffs.some(
      (handoff) =>
        isSideChatOpeningHandoff(handoff) &&
        handoff.toProviderThreadId === providerThreadId &&
        handoff.summaryText.includes(summary),
    )
  );
}

export interface SideChatContextHandoff {
  readonly handoff: OrchestrationV2ContextHandoff;
  readonly turnItem: OrchestrationV2TurnItem;
}

/**
 * A side-chat handoff for `run` and the timeline item that shows it. The text goes in
 * `summaryText` with no `history`, so it reaches the provider inline with the run's prompt.
 * `ordinalOffset` places the item relative to the run's user message (`run.ordinal * 100`).
 */
export function buildSideChatContextHandoff(input: {
  readonly id: ContextHandoffId;
  readonly title: string;
  readonly ordinalOffset: number;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly run: OrchestrationV2Run;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly summaryText: string;
  readonly turnItemId: TurnItemId;
  readonly createdAt: DateTime.Utc;
}): SideChatContextHandoff {
  const { run, createdAt } = input;
  return {
    handoff: {
      id: input.id,
      transferId: null,
      threadId: run.threadId,
      targetRunId: run.id,
      fromProviderThreadIds: [],
      toProviderThreadId: input.providerThreadId,
      coveredRunOrdinals: input.coveredRunOrdinals,
      strategy: "manual_context",
      status: "ready",
      summaryMessageId: null,
      summaryText: input.summaryText,
      createdByProviderInstanceId: null,
      createdAt,
      updatedAt: createdAt,
    },
    turnItem: {
      id: input.turnItemId,
      threadId: run.threadId,
      runId: run.id,
      nodeId: input.rootNodeId,
      providerThreadId: input.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: run.ordinal * 100 + input.ordinalOffset,
      status: "completed",
      title: input.title,
      startedAt: createdAt,
      completedAt: createdAt,
      updatedAt: createdAt,
      type: "handoff",
      contextHandoffId: input.id,
      fromProviderThreadIds: [],
      toProviderThreadId: input.providerThreadId,
      fromProviderInstanceIds: [],
      toProviderInstanceId: run.providerInstanceId,
      fromModelSelections: [],
      toModel: run.modelSelection.model,
      strategy: "manual_context",
      summary: input.summaryText,
    },
  };
}

/** The opening context for a side chat run whose provider thread starts fresh. */
export function buildSideChatOpeningContext(input: {
  readonly run: OrchestrationV2Run;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly summaryText: string;
  /** Whether `summaryText` carries the lesson summary rather than the fallback. */
  readonly withSummary: boolean;
  readonly turnItemId: TurnItemId;
  readonly createdAt: DateTime.Utc;
}): SideChatContextHandoff {
  const { withSummary, ...rest } = input;
  return buildSideChatContextHandoff({
    ...rest,
    id: sideChatOpeningHandoffId(input.run.id),
    title: withSummary ? SIDE_CHAT_CONTEXT_HANDOFF_TITLE : SIDE_CHAT_CONTEXT_FALLBACK_HANDOFF_TITLE,
    ordinalOffset: -1,
    coveredRunOrdinals: { from: 1, to: 1 },
  });
}

/**
 * A lesson summary owed to a side chat (`owedSideChatSummary`), handed to `run`. A run that has its
 * own opening context does not get one, so it takes the opening's place in the timeline.
 */
export function buildSideChatLateSummary(input: {
  readonly run: OrchestrationV2Run;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly summary: string;
  readonly turnItemId: TurnItemId;
  readonly createdAt: DateTime.Utc;
}): SideChatContextHandoff {
  const { summary, ...rest } = input;
  return buildSideChatContextHandoff({
    ...rest,
    id: sideChatLateSummaryHandoffId(input.run.id),
    title: SIDE_CHAT_SUMMARY_HANDOFF_TITLE,
    ordinalOffset: -1,
    coveredRunOrdinals: { from: input.run.ordinal, to: input.run.ordinal },
    summaryText: buildSideChatLateSummaryText(summary),
  });
}

/**
 * What the opening context needs beyond the side chat itself: the lesson's first request, which
 * stands in for a missing summary, and the opening summary of the side chat this one was opened
 * from, if any.
 */
export const loadSideChatOpeningSources = Effect.fn("loadSideChatOpeningSources")(function* (
  projectionStore: Pick<ProjectionStore.ProjectionStoreV2Shape, "getThreadRecords">,
  sideChat: OrchestrationV2SideChat,
) {
  // Finding the first request reads every user message of the lesson, so only without a summary.
  const lessonTopic =
    readySideChatSummary(sideChat.opening) !== null
      ? null
      : ((yield* projectionStore.getThreadRecords(sideChat.lessonThreadId, ["messages"], {
          messageRoles: ["user"],
        })).messages[0]?.text ?? null);
  const activeRuns = yield* projectionStore.getThreadRecords(sideChat.lessonThreadId, ["runs"], {
    runStatuses: ["preparing", "starting", "running", "waiting"],
  });
  const runningRun = activeRuns.runs.at(-1);
  const runningTurnItems =
    runningRun === undefined
      ? null
      : (yield* projectionStore.getThreadRecords(sideChat.lessonThreadId, ["turnItems"], {
          turnItemRunId: runningRun.id,
        })).turnItems;
  const parentOpeningText =
    sideChat.anchor.threadId === sideChat.lessonThreadId
      ? null
      : ((yield* projectionStore.getThreadRecords(sideChat.anchor.threadId, [])).thread.sideChat
          ?.opening.text ?? null);
  return { lessonTopic, parentOpeningText, runningTurnItems };
});
