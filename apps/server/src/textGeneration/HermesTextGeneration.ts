import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGenerationShape } from "./TextGeneration.ts";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const unsupported = (operation: TextGenerationOperation) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Hermes text generation is not implemented yet. Use Hermes for chat sessions.",
    }),
  );

export const makeHermesTextGeneration = (): TextGenerationShape => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
