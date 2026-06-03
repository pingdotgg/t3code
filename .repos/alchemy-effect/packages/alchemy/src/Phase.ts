import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export type AlchemyPhase = "plan" | "runtime";

export const ALCHEMY_PHASE = Config.string("ALCHEMY_PHASE").pipe(
  Config.withDefault("plan"),
  Config.mapOrFail((value) => {
    if (value !== "plan" && value !== "runtime") {
      return Effect.die(new Error(`Invalid ALCHEMY_PHASE: ${value}`));
    }
    return Effect.succeed(value as AlchemyPhase);
  }),
  Effect.orDie,
);
