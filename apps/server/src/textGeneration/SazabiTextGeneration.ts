/**
 * SazabiTextGeneration — heuristic, offline text generation for the Sazabi
 * cloud provider (scaffold).
 *
 * PR T1 does not call the Sazabi public API. Instead it derives thread titles,
 * branch names, commit messages, and PR content locally from the provided
 * context using the shared sanitizers. This keeps thread/branch/commit UX
 * working for Sazabi instances without a network round-trip; PR T2 can swap in
 * real model-backed generation over the public API if desired.
 *
 * @module textGeneration/SazabiTextGeneration
 */
import type { SazabiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

/** First non-empty line of a block, trimmed. */
function firstLine(value: string): string {
  for (const line of value.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

export const makeSazabiTextGeneration = Effect.fn("makeSazabiTextGeneration")(function* (
  sazabiSettings: SazabiSettings,
  _environment: NodeJS.ProcessEnv = process.env,
) {
  // Threaded through for parity with the other providers; T2 uses these to call
  // the Sazabi public API instead of the local heuristics below.
  yield* Effect.logDebug("Sazabi text generation constructed (scaffold; heuristic only).", {
    hasApiBaseUrl: sazabiSettings.apiBaseUrl.trim().length > 0,
  });

  // These are pure, synchronous heuristics (no network, no failure), so each is
  // an `Effect.sync` with a tracing span rather than a generator. PR T2 swaps
  // these for model-backed generation over the Sazabi public API.
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] = (
    input,
  ) =>
    Effect.sync(() => {
      const subject = sanitizeCommitSubject(firstLine(input.stagedSummary));
      return {
        subject,
        body: "",
        ...(input.includeBranch === true
          ? { branch: sanitizeFeatureBranchName(input.branch ?? subject) }
          : {}),
      };
    }).pipe(Effect.withSpan("SazabiTextGeneration.generateCommitMessage"));

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = (
    input,
  ) =>
    Effect.sync(() => {
      const title = sanitizePrTitle(firstLine(input.commitSummary) || input.headBranch);
      const bodyParts = [firstLine(input.commitSummary), firstLine(input.diffSummary)].filter(
        (part) => part.length > 0,
      );
      return {
        title,
        body: bodyParts.join("\n\n"),
      };
    }).pipe(Effect.withSpan("SazabiTextGeneration.generatePrContent"));

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = (
    input,
  ) =>
    Effect.sync(() => ({
      branch: sanitizeBranchFragment(firstLine(input.message) || input.message),
    })).pipe(Effect.withSpan("SazabiTextGeneration.generateBranchName"));

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = (
    input,
  ) =>
    Effect.sync(
      () =>
        ({
          title: sanitizeThreadTitle(input.message),
        }) satisfies TextGeneration.ThreadTitleGenerationResult,
    ).pipe(Effect.withSpan("SazabiTextGeneration.generateThreadTitle"));

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
