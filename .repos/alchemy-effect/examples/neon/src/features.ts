import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { ai } from "./ai/index.ts";
import Events from "./Events.ts";
import { forms } from "./forms/index.ts";

export const features = Effect.gen(function* () {
  yield* Events;
  const enableAI = yield* Config.String("NEON_EXAMPLE_AI").pipe(Config.withDefault("false"));
  const enableForms = yield* Config.String("NEON_EXAMPLE_FORMS").pipe(Config.withDefault("false"));
  return {
    ai: enableAI === "true" ? yield* ai : undefined,
    forms: enableForms === "true" ? yield* forms : undefined,
  };
});
