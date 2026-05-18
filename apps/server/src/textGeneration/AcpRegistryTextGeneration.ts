import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGenerationShape } from "./TextGeneration.ts";

// Registry agents are conversation-only in v1 — commit-message / PR / branch /
// title generation stays on the first-party providers. Every method fails
// with a clear error so callers fall back rather than hang.
const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Text generation is not supported for ACP registry agents.",
    }),
  );

export const makeAcpRegistryTextGeneration = (): TextGenerationShape => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
