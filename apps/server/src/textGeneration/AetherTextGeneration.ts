/**
 * AetherTextGeneration — deterministic, never-failing text generation stubs.
 *
 * Aether exposes no one-shot completion endpoint, so the driver ships
 * mechanical generators instead of model calls: commit subjects come from the
 * staged summary, PR title/body are passthrough truncation of the git
 * context, and branch names are slugs of the user's message plus the date.
 * None of these methods may fail — a failure here would block commit/PR
 * flows for no good reason.
 *
 * @module textGeneration/AetherTextGeneration
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { BRANCH_FRAGMENT_MAX_CHARS, sanitizeBranchFragment } from "@t3tools/shared/git";

import type * as TextGeneration from "./TextGeneration.ts";
import {
  limitSection,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PR_BODY_SECTION_MAX_CHARS = 4_000;

function firstNonEmptyLine(value: string): string | undefined {
  for (const line of value.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/** Deterministic commit message: subject = first staged-summary line. */
export function stubCommitMessage(input: {
  readonly stagedSummary: string;
  readonly includeBranch: boolean;
}): TextGeneration.CommitMessageGenerationResult {
  const subject = sanitizeCommitSubject(firstNonEmptyLine(input.stagedSummary) ?? "");
  return {
    subject,
    body: "",
    ...(input.includeBranch ? { branch: `feature/${sanitizeBranchFragment(subject)}` } : {}),
  };
}

/** Deterministic PR content: title from the commit summary, body = truncated passthrough. */
export function stubPrContent(input: {
  readonly headBranch: string;
  readonly commitSummary: string;
  readonly diffSummary: string;
}): TextGeneration.PrContentGenerationResult {
  const title = sanitizePrTitle(firstNonEmptyLine(input.commitSummary) ?? input.headBranch);
  const sections = [
    input.commitSummary.trim().length > 0
      ? `## Commits\n\n${limitSection(input.commitSummary.trim(), PR_BODY_SECTION_MAX_CHARS)}`
      : "",
    input.diffSummary.trim().length > 0
      ? `## Changes\n\n${limitSection(input.diffSummary.trim(), PR_BODY_SECTION_MAX_CHARS)}`
      : "",
  ].filter((section) => section.length > 0);
  return { title, body: sections.join("\n\n") };
}

/**
 * Deterministic branch name: message slug + ISO date, re-sanitized as one
 * fragment. The slug is truncated with room for the suffix RESERVED — the
 * sanitizer caps at 64 chars, so slugging first and trimming after cut the
 * date off any message at or past the cap and returned the same branch for
 * every date.
 */
export function stubBranchName(message: string, isoDate: string): string {
  const dateSuffix = `-${isoDate}`;
  const messageSlug = sanitizeBranchFragment(message).slice(
    0,
    BRANCH_FRAGMENT_MAX_CHARS - dateSuffix.length,
  );
  return sanitizeBranchFragment(`${messageSlug}${dateSuffix}`);
}

export function makeAetherTextGeneration(): TextGeneration.TextGeneration["Service"] {
  return {
    generateCommitMessage: (input) =>
      Effect.sync(() =>
        stubCommitMessage({
          stagedSummary: input.stagedSummary,
          includeBranch: input.includeBranch === true,
        }),
      ),
    generatePrContent: (input) =>
      Effect.sync(() =>
        stubPrContent({
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
        }),
      ),
    generateBranchName: (input) =>
      DateTime.now.pipe(
        Effect.map((now) => ({
          branch: stubBranchName(input.message, DateTime.formatIso(now).slice(0, 10)),
        })),
      ),
    generateThreadTitle: (input) =>
      Effect.sync(() => ({ title: sanitizeThreadTitle(input.message) })),
  } satisfies TextGeneration.TextGeneration["Service"];
}
