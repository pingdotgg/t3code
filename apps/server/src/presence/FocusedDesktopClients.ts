import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class FocusedDesktopClients extends Context.Reference<{
  /** True while at least one authenticated desktop focus stream is alive. */
  readonly anyFocused: Effect.Effect<boolean>;
  /** Current focus state followed by transitions of the aggregate state. */
  readonly changes: Stream.Stream<boolean>;
  /** A scope-bound lease held by one focused desktop WebSocket stream. */
  readonly acquire: Effect.Effect<void, never, Scope.Scope>;
}>("t3/presence/FocusedDesktopClients", {
  defaultValue: () => ({
    anyFocused: Effect.succeed(false),
    changes: Stream.empty,
    acquire: Effect.void,
  }),
}) {}

export const make = Effect.gen(function* () {
  const focusedCount = yield* SubscriptionRef.make(0);
  const anyFocused = SubscriptionRef.get(focusedCount).pipe(Effect.map((count) => count > 0));
  const changes = SubscriptionRef.changes(focusedCount).pipe(
    Stream.map((count) => count > 0),
    Stream.changes,
  );
  const acquire = Effect.acquireRelease(
    SubscriptionRef.update(focusedCount, (count) => count + 1),
    () => SubscriptionRef.update(focusedCount, (count) => Math.max(0, count - 1)),
  );

  return FocusedDesktopClients.of({
    anyFocused,
    changes,
    acquire,
  });
});

export function holdFocusLease(presence: {
  readonly acquire: Effect.Effect<void, never, Scope.Scope>;
}): Stream.Stream<never> {
  return Stream.fromEffect(presence.acquire).pipe(
    Stream.drain,
    Stream.concat(Stream.never),
    Stream.scoped,
  );
}

export const layer = Layer.effect(FocusedDesktopClients, make);
