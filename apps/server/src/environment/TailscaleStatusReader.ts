import {
  readTailscaleStatus,
  type TailscaleCommandError,
  type TailscaleStatus,
  type TailscaleStatusParseError,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

type TailscaleStatusError = TailscaleCommandError | TailscaleStatusParseError;

export class TailscaleStatusReader extends Context.Service<
  TailscaleStatusReader,
  {
    /** Joins the read already running, so concurrent callers spawn `tailscale status` once. */
    readonly read: () => Effect.Effect<TailscaleStatus, TailscaleStatusError>;
  }
>()("t3/environment/TailscaleStatusReader") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The layer's scope, so a caller that times out never interrupts the read others joined.
  const scope = yield* Effect.scope;
  let inFlight: Deferred.Deferred<TailscaleStatus, TailscaleStatusError> | undefined;

  const join = Effect.suspend(() => {
    if (inFlight !== undefined) return Effect.succeed(inFlight);
    const deferred = Deferred.makeUnsafe<TailscaleStatus, TailscaleStatusError>();
    inFlight = deferred;
    return readTailscaleStatus.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          inFlight = undefined;
          return Deferred.done(deferred, exit);
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

  return TailscaleStatusReader.of({
    read: Effect.fn("TailscaleStatusReader.read")(function* () {
      return yield* Deferred.await(yield* join);
    }),
  });
});

export const layer = Layer.effect(TailscaleStatusReader, make);
