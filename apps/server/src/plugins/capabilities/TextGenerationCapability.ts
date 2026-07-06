import type { TextGenerationCapability } from "@t3tools/plugin-sdk";

import * as TextGeneration from "../../textGeneration/TextGeneration.ts";

export function makeTextGenerationCapability(
  textGeneration: TextGeneration.TextGeneration["Service"],
): TextGenerationCapability {
  return {
    generateCommitMessage: (input) => textGeneration.generateCommitMessage(input),
    generatePrContent: (input) => textGeneration.generatePrContent(input),
    generateBranchName: (input) => textGeneration.generateBranchName(input),
    generateThreadTitle: (input) => textGeneration.generateThreadTitle(input),
    generateBoardProposal: (input) => textGeneration.generateBoardProposal(input),
  };
}
