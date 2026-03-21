import { Effect, Layer } from "effect";

import { inferProviderForModel } from "@t3tools/shared/model";

import {
  ClaudeTextGenerationBackend,
  CodexTextGenerationBackend,
} from "../Services/TextGenerationBackends.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";

export const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGenerationBackend;
  const claude = yield* ClaudeTextGenerationBackend;

  const resolveTextGenerationProvider = (model: string | null | undefined) =>
    inferProviderForModel(model, "codex") === "claudeAgent" ? claude : codex;

  return {
    generateCommitMessage: (input) =>
      resolveTextGenerationProvider(input.model).generateCommitMessage(input),
    generatePrContent: (input) =>
      resolveTextGenerationProvider(input.model).generatePrContent(input),
    generateBranchName: (input) =>
      input.attachments && input.attachments.length > 0
        ? codex.generateBranchName(input)
        : resolveTextGenerationProvider(input.model).generateBranchName(input),
  } satisfies TextGenerationShape;
});

export const RoutingTextGenerationLive = Layer.effect(TextGeneration, makeRoutingTextGeneration);
