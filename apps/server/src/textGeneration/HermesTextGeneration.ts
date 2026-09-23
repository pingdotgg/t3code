/**
 * HermesTextGeneration — Hermes has no out-of-session text-generation API
 * (no `codex exec`-style one-shot completion endpoint), only the
 * interactive ACP session used for chat turns. Every operation fails with
 * `TextGenerationError` so callers (commit messages, PR titles, branch
 * names, thread titles) fall back the same way they would for any other
 * provider instance that does not support this capability.
 *
 * @module HermesTextGeneration
 */
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Hermes has no out-of-session text-generation API.",
    }),
  );

export const makeHermesTextGeneration = (): ProviderInstance["textGeneration"] => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
