/**
 * TurnResponder layer.
 *
 * @module TurnResponder
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { OrchestrationMessageResponder, ThreadId, TurnId } from "@t3tools/contracts";
import { TurnResponder, type TurnResponderShape } from "../Services/TurnResponder.ts";

interface BoundTurn {
  readonly turnId: TurnId;
  readonly responder: OrchestrationMessageResponder;
}

interface ThreadResponders {
  /** Recorded by the reactor, not yet claimed by a provider turn. */
  readonly pending: OrchestrationMessageResponder | undefined;
  /** Newest last. */
  readonly turns: ReadonlyArray<BoundTurn>;
}

/**
 * Bound turns kept per thread. Completions can straggle in after the next turn
 * starts, so a couple of turns of history is enough to label them correctly
 * without holding every turn a long-lived thread ever ran.
 */
const TURN_HISTORY_LIMIT = 4;

const EMPTY_THREAD_RESPONDERS: ThreadResponders = { pending: undefined, turns: [] };

const makeTurnResponder = Effect.gen(function* () {
  const respondersRef = yield* Ref.make(new Map<ThreadId, ThreadResponders>());

  const update = (threadId: ThreadId, change: (state: ThreadResponders) => ThreadResponders) =>
    Ref.update(respondersRef, (byThread) =>
      new Map(byThread).set(threadId, change(byThread.get(threadId) ?? EMPTY_THREAD_RESPONDERS)),
    );

  return {
    record: ({ threadId, responder }) =>
      update(threadId, (state) => ({ ...state, pending: responder })),

    bind: ({ threadId, turnId }) =>
      update(threadId, (state) =>
        state.pending === undefined
          ? state
          : {
              pending: undefined,
              turns: [...state.turns, { turnId, responder: state.pending }].slice(
                -TURN_HISTORY_LIMIT,
              ),
            },
      ),

    get: ({ threadId, turnId }) =>
      Ref.get(respondersRef).pipe(
        Effect.map((byThread) => {
          const state = byThread.get(threadId);
          if (!state) {
            return undefined;
          }
          if (turnId === undefined) {
            return state.pending ?? state.turns.at(-1)?.responder;
          }
          const bound = state.turns.find((turn) => turn.turnId === turnId);
          if (bound) {
            return bound.responder;
          }
          // Nothing bound yet means the provider never reported a turn id we
          // could bind, so the parked selection is still the only candidate.
          // Once any turn is bound, an unknown turn id is a turn we did not
          // start and must not borrow another turn's label.
          return state.turns.length === 0 ? state.pending : undefined;
        }),
      ),
  } satisfies TurnResponderShape;
});

export const TurnResponderLive = Layer.effect(TurnResponder, makeTurnResponder);
