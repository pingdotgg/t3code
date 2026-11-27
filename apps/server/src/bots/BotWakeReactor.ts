import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as MilestoneHub from "../milestones/MilestoneHub.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as BotService from "./BotService.ts";

/**
 * Wakes a Bot when its workers, or a thread or workflow run it watches, reaches a milestone, and
 * keeps a Bot's own blocking questions from holding its turn open.
 */
export class BotWakeReactor extends Context.Service<
  BotWakeReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/bots/BotWakeReactor") {}

/** The question a domain event opens or completes, when it may be a blocking one. */
const questionOf = (event: OrchestrationV2DomainEvent) => {
  if (
    event.type === "runtime-request.updated" &&
    event.payload.kind === "user_input" &&
    event.payload.status === "pending" &&
    event.payload.responseCapability.type === "live"
  ) {
    return event.payload.id;
  }
  // Providers send a question's request and its card in either order; release needs both.
  if (
    event.type === "turn-item.updated" &&
    event.payload.type === "user_input_request" &&
    event.payload.status === "waiting" &&
    event.payload.responseMode === undefined
  ) {
    return event.payload.requestId;
  }
  return null;
};

const make = Effect.gen(function* () {
  const hub = yield* MilestoneHub.MilestoneHub;
  const bots = yield* BotService.BotService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // Untraced: runs for every domain event, and nearly all return at the type check.
  const releaseBotQuestion = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const requestId = questionOf(event);
    if (requestId === null) return;
    const thread = yield* projections.getThread(event.threadId);
    if (thread.botConfig == null || thread.lineage.parentThreadId !== null) return;
    yield* engine.dispatch({
      type: "runtime-request.release-to-message",
      commandId: CommandId.make(`server:bot-question-release:${requestId}:${event.type}`),
      threadId: event.threadId,
      requestId,
    });
  });

  const start: BotWakeReactor["Service"]["start"] = Effect.fn("BotWakeReactor.start")(function* () {
    const events = yield* hub.subscribe({
      types: BotService.BOT_WAKING_MILESTONES,
      includeSubagentChildren: false,
    });
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        bots.handleMilestone(event).pipe(Effect.ignoreCause({ log: true })),
      ),
    );
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        releaseBotQuestion(event).pipe(Effect.ignoreCause({ log: true })),
      ).pipe(Effect.ignoreCause({ log: true })),
    );
  });
  return BotWakeReactor.of({ start });
});

export const layer = Layer.effect(BotWakeReactor, make);
