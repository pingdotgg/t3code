// @effect-diagnostics nodeBuiltinImport:off - Speech Rule Engine is required from disk, beside its rule files.
import * as NodeModule from "node:module";
import type { SpeechMathRequest } from "@t3tools/contracts";
import { speakTex } from "@t3tools/shared/read-aloud";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

type Formula = (typeof SpeechMathRequest.Type)["formulas"][number];

type SpeechRuleEngine = {
  readonly setupEngine: (options: Readonly<Record<string, string>>) => Promise<void>;
  readonly engineReady: () => Promise<void>;
  readonly toSpeech: (mathml: string) => string;
};

/** Reads formulas as the words screen readers say for them, for clients that cannot. */
export class MathSpeech extends Context.Service<
  MathSpeech,
  {
    /** Words for each formula in order; null for one KaTeX cannot parse, read as its TeX. */
    readonly speak: (
      formulas: ReadonlyArray<Formula>,
      language: string,
    ) => Effect.Effect<ReadonlyArray<string | null>>;
  }
>()("t3/speech/MathSpeech") {}

let engine: Promise<SpeechRuleEngine> | undefined;
// Its Node build finds its rules beside itself, and single-executables cannot import disk packages.
const loadEngine = () =>
  (engine ??= (async () => {
    const packagePath = NodeModule.findPackageJSON("speech-rule-engine", import.meta.url);
    if (!packagePath) throw new Error("Speech Rule Engine is unavailable.");
    return NodeModule.createRequire(packagePath)("./lib/sre.js") as SpeechRuleEngine;
  })());

const make = Effect.gen(function* () {
  // One engine serves every request and its language is switched per request, so they take turns.
  const turn = yield* Semaphore.make(1);
  let locale = "";

  const speak = Effect.fn("MathSpeech.speak")(function* (
    formulas: ReadonlyArray<Formula>,
    language: string,
  ) {
    if (formulas.length === 0) return [];
    return yield* turn
      .withPermits(1)(
        Effect.promise(async () => {
          const [sre, katex] = await Promise.all([loadEngine(), import("katex")]);
          // Languages without rules are read in English, as the engine falls back to it.
          const wanted = language.split("-")[0]!.toLowerCase();
          if (wanted !== locale) {
            await sre.setupEngine({ locale: wanted, domain: "clearspeak", modality: "speech" });
            await sre.engineReady();
            locale = wanted;
          }
          return formulas.map(
            ({ tex, display }) => speakTex(katex.default, sre.toSpeech, tex, display) ?? null,
          );
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Formula speech failed; formulas are read as TeX.", cause).pipe(
            Effect.as(formulas.map(() => null)),
          ),
        ),
      );
  });

  return MathSpeech.of({ speak });
});

export const layer = Layer.effect(MathSpeech, make);
