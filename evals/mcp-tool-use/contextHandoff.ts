/**
 * The inline history a context restart delivers, built by T3's own preparation and delivery code
 * from a case's fake thread. Only the thread and its summaries are the case's.
 */
import {
  ContextHandoffId,
  ConversationSummaryId,
  MessageId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { handoffCoverage, historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { deliverContextHandoffs } from "../../apps/server/src/orchestration-v2/ContextHandoffDelivery.ts";
import { renderSummaryForHandoff } from "../../apps/server/src/project/conversationSummaries/ConversationSummaries.ts";

const Item = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literals(["user_message", "assistant_message"]),
    text: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("command_execution"),
    input: Schema.String,
    output: Schema.String,
    exitCode: Schema.Int,
  }),
]);

/** A restarted thread: its carried items, the older ones preparation dropped, and summaries. */
export const ContextHandoffFixture = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.String,
  /** Delivery budget in estimated tokens. */
  budget: Schema.Number,
  items: Schema.Array(Item),
  /** Older items preparation left out, oldest first: delivery knows only their ids. */
  omittedItemIds: Schema.optional(Schema.Array(Schema.String)),
  summaries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      coveredItemIds: Schema.Array(Schema.String),
      /** Each statement cites covered item ids. */
      statements: Schema.Array(
        Schema.Struct({ text: Schema.String, cites: Schema.Array(Schema.String) }),
      ),
      /** false: too large to send beside the history, so delivery only knows it exists. */
      fits: Schema.Boolean,
    }),
  ),
});
export type ContextHandoffFixture = typeof ContextHandoffFixture.Type;

const at = DateTime.makeUnsafe("2026-11-15T09:00:00.000Z");
const digest = "a".repeat(64);

const turnItem = (
  fixture: ContextHandoffFixture,
  item: typeof Item.Type,
  ordinal: number,
): OrchestrationV2TurnItem => {
  const base = {
    id: TurnItemId.make(item.id),
    threadId: ThreadId.make(fixture.threadId),
    runId: RunId.make("run-before-restart"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  switch (item.type) {
    case "user_message":
      return {
        ...base,
        type: item.type,
        messageId: MessageId.make(`message-${item.id}`),
        createdBy: "user",
        creationSource: "server",
        inputIntent: "turn_start",
        text: item.text,
        attachments: [],
      };
    case "assistant_message":
      return {
        ...base,
        type: item.type,
        messageId: MessageId.make(`message-${item.id}`),
        text: item.text,
        streaming: false,
      };
    case "command_execution":
      return { ...base, ...item, id: base.id };
  }
};

/** The context T3 puts ahead of the user's text on the restarted conversation's first turn. */
export const contextHandoffPrompt = (fixture: ContextHandoffFixture): string => {
  const threadId = ThreadId.make(fixture.threadId);
  const projectId = ProjectId.make(fixture.projectId);
  const items = fixture.items.map((item, index) => turnItem(fixture, item, index + 1));
  const messages = items.flatMap((item) => historicalMessage(item) ?? []);
  const handoff: OrchestrationV2ContextHandoff = {
    id: ContextHandoffId.make("handoff-restart"),
    transferId: null,
    threadId,
    targetRunId: RunId.make("run-after-restart"),
    fromProviderThreadIds: [],
    toProviderThreadId: ProviderThreadId.make("provider-thread-fresh"),
    coveredRunOrdinals: { from: 1, to: 4 },
    strategy: "full_thread_summary",
    status: "ready",
    summaryMessageId: null,
    summaryText: "",
    history: {
      messages,
      coverage: handoffCoverage({ threadId, coveredRunOrdinals: { from: 1, to: 4 }, items }),
      omittedItems: fixture.omittedItemIds?.length ?? 0,
      omittedItemIds: (fixture.omittedItemIds ?? []).map((id) => TurnItemId.make(id)),
    },
    createdByProviderInstanceId: null,
    createdAt: at,
    updatedAt: at,
  };
  const summaries = fixture.summaries.map((summary) => {
    const id = ConversationSummaryId.make(summary.id);
    const text = renderSummaryForHandoff({
      id,
      projectId,
      threadId,
      sources: summary.coveredItemIds.map((itemId) => ({
        kind: "turn_item" as const,
        threadId,
        itemId: TurnItemId.make(itemId),
        digest,
      })),
      statements: summary.statements.map((statement) => ({
        text: statement.text,
        citations: statement.cites.map((itemId) => `turn_item:${itemId}`),
      })),
    });
    return {
      id,
      projectId,
      threadId,
      // An offer that cannot fit is never shown, so its padding never reaches the model.
      text: summary.fits ? text : `${text}\n${" ".repeat(fixture.budget * 8)}`,
      coveredItemIds: summary.coveredItemIds.map((itemId) => TurnItemId.make(itemId)),
    };
  });
  const delivery = Effect.runSync(
    deliverContextHandoffs({
      handoffs: [handoff],
      providerThread: {
        id: handoff.toProviderThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
      },
      budget: fixture.budget,
      alreadyDeliveredItemIds: new Set(),
      persist: () => Effect.void,
      summaries: () => Effect.succeed(summaries),
    }),
  );
  return delivery.context;
};
