import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

export interface PreviewAgentTurnChange {
  readonly threadId: ThreadId;
  readonly active: boolean;
}

/**
 * Whether an agent turn runs on a thread, model thinking included, so its preview tab
 * stays focused between tool calls. Background commands outlive the turn and do not count.
 */
export class PreviewAgentActivity extends Context.Service<
  PreviewAgentActivity,
  {
    /** Marks the thread active until the returned effect runs; it runs at most once. */
    readonly begin: (threadId: ThreadId) => Effect.Effect<Effect.Effect<void>>;
    readonly active: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Each thread's transitions between no turn and some turn, from subscription on. */
    readonly changes: Effect.Effect<
      PubSub.Subscription<PreviewAgentTurnChange>,
      never,
      Scope.Scope
    >;
  }
>()("t3/preview/PreviewAgentActivity") {}

const make = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<PreviewAgentTurnChange>();
  // A token per turn, so overlapping turns on one thread end only when the last does.
  const turns = new Map<ThreadId, Set<symbol>>();

  const begin = Effect.fn("PreviewAgentActivity.begin")(function* (threadId: ThreadId) {
    const existing = turns.get(threadId);
    const tokens = existing ?? new Set<symbol>();
    if (existing === undefined) turns.set(threadId, tokens);
    const token = Symbol(threadId);
    tokens.add(token);
    if (existing === undefined) yield* PubSub.publish(changes, { threadId, active: true });
    return Effect.suspend(() => {
      if (!tokens.delete(token) || tokens.size > 0) return Effect.void;
      if (turns.get(threadId) === tokens) turns.delete(threadId);
      return PubSub.publish(changes, { threadId, active: false }).pipe(Effect.asVoid);
    });
  });

  return PreviewAgentActivity.of({
    begin,
    active: Effect.fn("PreviewAgentActivity.active")(function (threadId) {
      return Effect.sync(() => turns.has(threadId));
    }),
    changes: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(PreviewAgentActivity, make);
