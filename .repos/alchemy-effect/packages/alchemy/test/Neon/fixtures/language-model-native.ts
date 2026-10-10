import * as Neon from "@/Neon";
import * as Effect from "effect/Effect";
import { languageModelHandler } from "./language-model-handler.ts";
import { languageModelBranch } from "./language-model-resources.ts";

export default class NativeLanguageModel extends Neon.Function<NativeLanguageModel>()(
  "NativeLanguageModel",
  Effect.gen(function* () {
    return {
      branch: yield* languageModelBranch,
      main: import.meta.url,
      env: { AI_MODEL: process.env.NEON_TEST_AI_MODEL ?? "gpt-5-mini" },
    };
  }),
  languageModelHandler().pipe(Effect.provide(Neon.QueryAIGatewayHttp)),
) {}
