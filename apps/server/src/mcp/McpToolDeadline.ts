import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/**
 * How long one tool call may work. Time it spends asking a person to approve it is not
 * counted: they take as long as they like. Longer than the longest wait a tool sets itself.
 */
export const ACTIVE_TIME_LIMIT = Duration.minutes(65);

export const timedOut = (tool: string, limit: Duration.Duration) =>
  `Stopped: ${tool} ran for ${Math.round(Duration.toMinutes(limit))} minutes without finishing, so T3 Code ended the call. What it had already sent to a remote, a forge or another environment may still have taken effect. Check the state before calling again.`;

/** The clock of the tool call in progress, for the part of it that waits on a person. */
export class McpToolDeadline extends Context.Service<
  McpToolDeadline,
  {
    readonly whileWaitingOnPerson: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/mcp/McpToolDeadline") {}

/** Runs `effect` with the call's clock stopped. A call with no clock just runs it. */
export const whileWaitingOnPerson = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.serviceOption(McpToolDeadline).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (deadline) => deadline.whileWaitingOnPerson(effect),
      }),
    ),
  );

interface Counting {
  /** How many parts of the call wait on a person now. The clock runs while there are none. */
  readonly waiting: number;
  /** Done when the clock next stops or starts. */
  readonly turned: Deferred.Deferred<void>;
}

/**
 * Runs `handle` for at most `limit` of counted time. At the limit the answer is none at once,
 * and `handle` is interrupted without being waited for: what it runs that ignores interruption
 * goes on, and no longer holds the call.
 */
export const within = <A, E, R>(
  limit: Duration.Duration,
  handle: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, E, Exclude<R, McpToolDeadline>> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const counting = yield* Ref.make<Counting>({
        waiting: 0,
        turned: Deferred.makeUnsafe(),
      });
      const count = (by: 1 | -1) =>
        Ref.modify(counting, (current): [Deferred.Deferred<void> | undefined, Counting] => {
          const waiting = current.waiting + by;
          return (current.waiting === 0) === (waiting === 0)
            ? [undefined, { ...current, waiting }]
            : [current.turned, { waiting, turned: Deferred.makeUnsafe() }];
        }).pipe(
          Effect.flatMap((turned) =>
            turned === undefined ? Effect.void : Deferred.succeed(turned, undefined),
          ),
        );
      const expired = Effect.gen(function* () {
        let left = Duration.toMillis(limit);
        while (true) {
          const { waiting, turned } = yield* Ref.get(counting);
          if (waiting > 0) {
            yield* Deferred.await(turned);
            continue;
          }
          const since = yield* Clock.currentTimeMillis;
          const ranOut = yield* Effect.raceFirst(
            Effect.as(Effect.sleep(Duration.millis(left)), true),
            Effect.as(Deferred.await(turned), false),
          );
          if (ranOut) return Option.none<A>();
          left = Math.max(0, left - ((yield* Clock.currentTimeMillis) - since));
        }
      });
      const running = yield* restore(handle).pipe(
        Effect.provideService(McpToolDeadline, {
          whileWaitingOnPerson: (effect) =>
            Effect.acquireUseRelease(
              count(1),
              () => effect,
              () => count(-1),
            ),
        }),
        Effect.forkDetach,
      );
      const stop = Fiber.interrupt(running);
      const outcome = yield* restore(
        Effect.raceFirst(Effect.asSome(Fiber.join(running)), expired),
      ).pipe(Effect.onInterrupt(() => stop));
      if (Option.isNone(outcome)) yield* Effect.forkDetach(stop);
      return outcome;
    }),
  ) as Effect.Effect<Option.Option<A>, E, Exclude<R, McpToolDeadline>>;
