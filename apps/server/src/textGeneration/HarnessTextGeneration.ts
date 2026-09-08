import * as Effect from "effect/Effect";
import type { HarnessSettings } from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";

import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

/**
 * Heuristic text generation for Harness until Mixr proxies live completions
 * for git/title jobs. Keeps the driver usable without a frontier model call.
 */
export const makeHarnessTextGeneration = Effect.fn("makeHarnessTextGeneration")(function* (
  _settings: HarnessSettings,
) {
  void _settings;

  const firstLine = (message: string): string => {
    const line = message
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    return line ?? "update";
  };

  return TextGeneration.TextGeneration.of({
    generateCommitMessage: (input) =>
      Effect.sync(() => {
        const subject = sanitizeCommitSubject(firstLine(input.stagedSummary || input.stagedPatch));
        return {
          subject,
          body: "",
          ...(input.includeBranch ? { branch: sanitizeFeatureBranchName(subject) } : {}),
        };
      }),
    generatePrContent: (input) =>
      Effect.sync(() => {
        const title = sanitizePrTitle(firstLine(input.commitSummary || input.diffSummary));
        return {
          title,
          body: input.diffSummary.slice(0, 4_000),
        };
      }),
    generateBranchName: (input) =>
      Effect.sync(() => ({
        branch: sanitizeFeatureBranchName(firstLine(input.message)),
      })),
    generateThreadTitle: (input) =>
      Effect.sync(() => ({
        title: sanitizeThreadTitle(firstLine(input.message)),
      })),
  });
});
