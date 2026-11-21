import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as BotService from "./BotService.ts";

const TICK_INTERVAL = Duration.seconds(30);

export class BotScheduler extends Context.Service<
  BotScheduler,
  {
    readonly tickNow: () => Effect.Effect<void>;
  }
>()("t3/bots/BotScheduler") {}

const make = Effect.gen(function* () {
  const botService = yield* BotService.BotService;

  const tickNow = Effect.fn("BotScheduler.tickNow")(function* () {
    yield* botService
      .runDueRoutines()
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Bot scheduler failed to run due routines").pipe(
            Effect.annotateLogs({ error: error.message }),
          ),
        ),
      );
    yield* botService
      .sweepStaleItems()
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Bot scheduler failed to sweep stale items").pipe(
            Effect.annotateLogs({ error: error.message }),
          ),
        ),
      );
  });

  yield* tickNow().pipe(Effect.repeat(Schedule.spaced(TICK_INTERVAL)), Effect.forkScoped);

  return BotScheduler.of({ tickNow });
});

export const layer = Layer.effect(BotScheduler, make);
