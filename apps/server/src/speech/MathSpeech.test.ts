import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";

import * as MathSpeech from "./MathSpeech.ts";

it.effect("reads formulas as words in the app's language, and leaves unparsable ones as TeX", () =>
  Effect.gen(function* () {
    const math = yield* MathSpeech.MathSpeech;
    expect(
      yield* math.speak(
        [
          { tex: "E = mc^2", display: true },
          { tex: "\\frac{", display: false },
        ],
        "en-US",
      ),
    ).toEqual(["E equals m c squared", null]);
    expect(yield* math.speak([{ tex: "x^2", display: false }], "de")).toEqual(["x Quadrat"]);
    // Without rules for the language, formulas are read in English.
    expect(yield* math.speak([{ tex: "x^2", display: false }], "pt-BR")).toEqual(["x squared"]);
  }).pipe(Effect.provide(MathSpeech.layer)),
);
