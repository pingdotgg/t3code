import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TextGeneration } from "./TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Prime Agent text generation is not supported yet. Choose another provider for this.",
    }),
  );

export const makePrimeAgentTextGeneration = (): TextGeneration["Service"] => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
