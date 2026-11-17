// A requested feedback report waits here for the user's Send or Don't send. Only the call that is
// still waiting can store the report, so an answer with no waiter sends nothing.
import {
  type AgentFeedbackAnswerInput,
  AgentFeedbackRequestError,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

export type FeedbackDecision = "send" | "decline";

export class FeedbackApprovals extends Context.Service<
  FeedbackApprovals,
  {
    /** Registers the card's waiter for the scope; open it before the card is shown. */
    readonly open: (card: {
      readonly threadId: ThreadId;
      readonly turnItemId: TurnItemId;
    }) => Effect.Effect<Deferred.Deferred<FeedbackDecision>, never, Scope.Scope>;
    readonly answer: (
      input: AgentFeedbackAnswerInput,
    ) => Effect.Effect<void, AgentFeedbackRequestError>;
  }
>()("t3/feedback/FeedbackApprovals") {}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const waiting = new Map<
    TurnItemId,
    { readonly threadId: ThreadId; readonly decision: Deferred.Deferred<FeedbackDecision> }
  >();

  const open: FeedbackApprovals["Service"]["open"] = (card) =>
    Effect.acquireRelease(
      Deferred.make<FeedbackDecision>().pipe(
        Effect.tap((decision) =>
          Effect.sync(() => waiting.set(card.turnItemId, { threadId: card.threadId, decision })),
        ),
      ),
      () => Effect.sync(() => waiting.delete(card.turnItemId)),
    );

  const answer = Effect.fn("FeedbackApprovals.answer")(function* (input: AgentFeedbackAnswerInput) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "agent_feedback.answer": input.answer,
    });
    const pending = waiting.get(input.turnItemId);
    if (pending !== undefined && pending.threadId === input.threadId) {
      if (yield* Deferred.succeed(pending.decision, input.answer)) return;
      return yield* new AgentFeedbackRequestError({ reason: "already_answered" });
    }
    const records = yield* threads
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["feedback_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((cause) => new AgentFeedbackRequestError({ reason: "load_failed", cause })),
      );
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    if (item?.type !== "feedback_request") {
      return yield* new AgentFeedbackRequestError({ reason: "not_found" });
    }
    return yield* new AgentFeedbackRequestError({
      reason: item.feedbackStatus === "pending" ? "agent_stopped" : "already_answered",
    });
  });

  return FeedbackApprovals.of({ open, answer });
});

export const layer = Layer.effect(FeedbackApprovals, make);
