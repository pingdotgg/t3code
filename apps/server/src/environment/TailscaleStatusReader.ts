import {
  readTailscaleStatus,
  type TailscaleCommandError,
  type TailscaleStatus,
  type TailscaleStatusParseError,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

type TailscaleStatusError = TailscaleCommandError | TailscaleStatusParseError;

export class TailscaleStatusReader extends Context.Service<
  TailscaleStatusReader,
  {
    readonly read: () => Effect.Effect<TailscaleStatus, TailscaleStatusError>;
    /** Emits when a read settles to a different outcome than the previous settled read. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("t3/environment/TailscaleStatusReader") {}

/** Answer from the last settled read without refreshing, for re-resolves that a settled change drives. */
export const SettledReadOnly = Context.Reference<boolean>(
  "t3/environment/TailscaleStatusReader/SettledReadOnly",
  { defaultValue: () => false },
);

// A healthy CLI answers in tens of milliseconds, so a connect still gets a fresh read from it.
const FRESH_READ_GRACE = Duration.millis(250);

// Callers treat every failure alike, so failures compare equal regardless of cause.
const outcomeKey = (exit: Exit.Exit<TailscaleStatus, TailscaleStatusError>) =>
  Exit.isSuccess(exit) ? JSON.stringify(exit.value) : null;

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The layer's scope, so a caller that times out or disconnects never interrupts the shared read.
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.unbounded<void>();
  let settled: Exit.Exit<TailscaleStatus, TailscaleStatusError> | undefined;
  let inFlight: Deferred.Deferred<TailscaleStatus, TailscaleStatusError> | undefined;

  const refresh = Effect.suspend(() => {
    if (inFlight !== undefined) return Effect.succeed(inFlight);
    const deferred = Deferred.makeUnsafe<TailscaleStatus, TailscaleStatusError>();
    inFlight = deferred;
    return readTailscaleStatus.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          const changed = settled === undefined || outcomeKey(settled) !== outcomeKey(exit);
          settled = exit;
          inFlight = undefined;
          return Deferred.done(deferred, exit).pipe(
            Effect.andThen(changed ? PubSub.publish(changes, undefined) : Effect.void),
          );
        }),
      ),
      Effect.interruptible,
      Effect.forkIn(scope),
      Effect.as(deferred),
    );
  }).pipe(
    // Claiming `inFlight` and forking are one step: an interrupt between them would strand the claim.
    Effect.uninterruptible,
  );
  yield* refresh;

  return TailscaleStatusReader.of({
    // A caller gets the refresh it starts or joins if that settles within the grace, else the
    // previous read's result; a later outcome reaches open subscribers through `subscribeChanges`.
    read: Effect.fn("TailscaleStatusReader.read")(function* () {
      const previous = settled;
      if (previous !== undefined && (yield* SettledReadOnly)) return yield* previous;
      const pending = yield* refresh;
      if (previous === undefined) return yield* Deferred.await(pending);
      const fresh = yield* Deferred.await(pending).pipe(
        Effect.exit,
        Effect.timeoutOption(FRESH_READ_GRACE),
      );
      return yield* Option.getOrElse(fresh, () => previous);
    }),
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(TailscaleStatusReader, make);
