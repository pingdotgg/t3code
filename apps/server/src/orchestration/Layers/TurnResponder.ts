/**
 * TurnResponder layer.
 *
 * @module TurnResponder
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { OrchestrationMessageResponder, ThreadId } from "@t3tools/contracts";
import { TurnResponder, type TurnResponderShape } from "../Services/TurnResponder.ts";

const makeTurnResponder = Effect.gen(function* () {
  const respondersRef = yield* Ref.make(new Map<ThreadId, OrchestrationMessageResponder>());

  return {
    record: ({ threadId, responder }) =>
      Ref.update(respondersRef, (responders) => new Map(responders).set(threadId, responder)),
    get: (threadId) => Ref.get(respondersRef).pipe(Effect.map((map) => map.get(threadId))),
    forget: (threadId) =>
      Ref.update(respondersRef, (responders) => {
        const next = new Map(responders);
        next.delete(threadId);
        return next;
      }),
  } satisfies TurnResponderShape;
});

export const TurnResponderLive = Layer.effect(TurnResponder, makeTurnResponder);
