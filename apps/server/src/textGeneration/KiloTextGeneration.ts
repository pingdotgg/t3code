import * as Effect from "effect/Effect";

import { type KiloSettings, TextGenerationError } from "@t3tools/contracts";
import type * as TextGeneration from "./TextGeneration.ts";

/**
 * Kilo text generation is not implemented in v1. The driver still exposes a
 * typed service so instance construction matches other providers; all ops
 * fail with a clear unsupported message.
 */
export const makeKiloTextGeneration = (
  _kiloSettings: KiloSettings,
  _environment?: NodeJS.ProcessEnv,
): Effect.Effect<TextGeneration.TextGeneration["Service"]> =>
  Effect.succeed({
    generateCommitMessage: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateCommitMessage",
          detail: "Kilo does not support git/text generation in T3 Code yet.",
        }),
      ),
    generatePrContent: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generatePrContent",
          detail: "Kilo does not support git/text generation in T3 Code yet.",
        }),
      ),
    generateBranchName: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "Kilo does not support git/text generation in T3 Code yet.",
        }),
      ),
    generateThreadTitle: () =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "Kilo does not support git/text generation in T3 Code yet.",
        }),
      ),
  });
