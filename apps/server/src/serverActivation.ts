import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

/** Forks a long-running root before commit, returning it after it reaches the activation boundary. */
export const forkParkedFiber = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Fiber.Fiber<A, E>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      return yield* Effect.forkScoped(effect);
    }
    const parked = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkScoped(
      Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
    );
    yield* Deferred.await(parked);
    return fiber;
  });

/** Forks a long-running root before commit and proves it is parked at the activation boundary. */
export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> => forkParkedFiber(effect).pipe(Effect.asVoid);

export interface BackgroundStart {
  /** Opens once the first client has its config, or a while after activation without one. */
  readonly awaitFirstClient: Effect.Effect<void>;
  /** Waits for this caller's staggered start once startup has gone quiet. */
  readonly awaitTurn: Effect.Effect<void>;
  readonly markClientServed: Effect.Effect<void>;
}

/**
 * Gate for startup work no client waits on: settlement and pull request
 * sweeps, cache prunes, first provider probes, the boot heartbeat. Started at
 * activation, that work spawned over a hundred processes and kept the event
 * loop busy for seconds while the first client loaded. Unset (tests, CLI
 * tools) means start now.
 */
export class ServerBackgroundStart extends Context.Reference<BackgroundStart | undefined>(
  "t3/serverBackgroundStart",
  { defaultValue: () => undefined },
) {}

const FIRST_CLIENT_WAIT = Duration.seconds(10);
const QUIET_AFTER_ACTIVATION = Duration.seconds(10);
const QUIET_MAX_WAIT = Duration.seconds(30);
const TURN_STAGGER_MILLIS = 2_000;

/**
 * Provider probes start once the first client has its config. Maintenance
 * starts once that client is served and the server has been active for
 * `QUIET_AFTER_ACTIVATION` (at most `QUIET_MAX_WAIT` after activation), one
 * job every `TURN_STAGGER_MILLIS`. Callers that arrive later start at once.
 */
export const makeBackgroundStart = (activation: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const clientServed = yield* Deferred.make<void>();
    const firstClient = yield* Deferred.make<void>();
    const quiet = yield* Deferred.make<void>();
    const awaitClientServed = Deferred.await(clientServed);
    yield* activation.pipe(
      Effect.andThen(
        Effect.all(
          [
            awaitClientServed.pipe(
              Effect.timeoutOption(FIRST_CLIENT_WAIT),
              Effect.andThen(Deferred.succeed(firstClient, undefined)),
            ),
            Effect.all([Effect.sleep(QUIET_AFTER_ACTIVATION), awaitClientServed], {
              concurrency: "unbounded",
            }).pipe(
              Effect.timeoutOption(QUIET_MAX_WAIT),
              Effect.andThen(Deferred.succeed(quiet, undefined)),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.forkScoped,
    );
    let nextStartAt = 0;
    return {
      awaitFirstClient: Deferred.await(firstClient),
      awaitTurn: Deferred.await(quiet).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((now) => {
          const startAt = Math.max(now, nextStartAt);
          nextStartAt = startAt + TURN_STAGGER_MILLIS;
          return startAt > now ? Effect.sleep(Duration.millis(startAt - now)) : Effect.void;
        }),
      ),
      markClientServed: Deferred.succeed(clientServed, undefined).pipe(Effect.asVoid),
    } satisfies BackgroundStart;
  });

/** See `BackgroundStart.awaitTurn`. */
export const awaitBackgroundTurn: Effect.Effect<void> = Effect.gen(function* () {
  const gate = yield* ServerBackgroundStart;
  if (gate !== undefined) yield* gate.awaitTurn;
});

/** See `BackgroundStart.markClientServed`. */
export const markClientServed: Effect.Effect<void> = Effect.gen(function* () {
  const gate = yield* ServerBackgroundStart;
  if (gate !== undefined) yield* gate.markClientServed;
});

/** `forkParked` for deferrable startup work: it also waits for its background turn. */
export const forkBackground = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> =>
  forkParked(Effect.andThen(awaitBackgroundTurn, effect));
