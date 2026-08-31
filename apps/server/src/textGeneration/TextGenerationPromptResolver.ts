import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { T3ProjectFileTextGenerationPrompts } from "@t3tools/contracts";

import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";

export class TextGenerationPromptResolver extends Context.Service<
  TextGenerationPromptResolver,
  {
    readonly resolve: (
      workspaceRoot: string,
    ) => Effect.Effect<T3ProjectFileTextGenerationPrompts | undefined>;
  }
>()("t3/textGeneration/TextGenerationPromptResolver") {}

export const make = Effect.gen(function* () {
  const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const resolve: TextGenerationPromptResolver["Service"]["resolve"] = Effect.fn(
    "TextGenerationPromptResolver.resolve",
  )(function* (workspaceRoot) {
    const projectFile = yield* loader.load(workspaceRoot);
    return Option.getOrUndefined(projectFile)?.textGeneration?.prompts;
  });

  return TextGenerationPromptResolver.of({ resolve });
});

export const layer = Layer.effect(TextGenerationPromptResolver, make);
