/**
 * Decoding for the artefact types the report header renders. PostHog keeps
 * artefact content open-ended, so each type is decoded leniently and anything
 * that does not match is skipped rather than failing the whole report.
 */
import {
  PostHogActionabilityAssessment,
  PostHogCodeReference,
  PostHogPriorityAssessment,
  PostHogRepoSelection,
  PostHogSignalFinding,
  PostHogSuggestedReviewers,
  type PostHogReportArtefact,
  type PostHogSuggestedReviewer,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeFinding = Schema.decodeUnknownOption(PostHogSignalFinding);
const decodePriority = Schema.decodeUnknownOption(PostHogPriorityAssessment);
const decodeActionability = Schema.decodeUnknownOption(PostHogActionabilityAssessment);
const decodeCodeReference = Schema.decodeUnknownOption(PostHogCodeReference);
const decodeReviewers = Schema.decodeUnknownOption(PostHogSuggestedReviewers);
const decodeRepoSelection = Schema.decodeUnknownOption(PostHogRepoSelection);

function decodeAll<A>(
  artefacts: ReadonlyArray<PostHogReportArtefact>,
  type: string,
  decode: (content: unknown) => Option.Option<A>,
): ReadonlyArray<{ readonly id: string; readonly value: A }> {
  return artefacts
    .filter((artefact) => artefact.type === type)
    .flatMap((artefact) =>
      Option.toArray(decode(artefact.content)).map((value) => ({ id: artefact.id, value })),
    );
}

export interface ReportArtefactView {
  readonly findings: ReadonlyArray<{
    readonly id: string;
    readonly value: PostHogSignalFinding;
  }>;
  readonly priority: PostHogPriorityAssessment | null;
  readonly actionability: PostHogActionabilityAssessment | null;
  readonly codeReferences: ReadonlyArray<{
    readonly id: string;
    readonly value: PostHogCodeReference;
  }>;
  readonly reviewers: ReadonlyArray<PostHogSuggestedReviewer>;
  readonly repoSelection: PostHogRepoSelection | null;
}

/** Status artefacts are latest-wins on the PostHog side; the API lists newest first. */
export function readReportArtefacts(
  artefacts: ReadonlyArray<PostHogReportArtefact>,
): ReportArtefactView {
  return {
    findings: decodeAll(artefacts, "signal_finding", decodeFinding),
    priority: decodeAll(artefacts, "priority_judgment", decodePriority)[0]?.value ?? null,
    actionability:
      decodeAll(artefacts, "actionability_judgment", decodeActionability)[0]?.value ?? null,
    codeReferences: decodeAll(artefacts, "code_reference", decodeCodeReference),
    reviewers: decodeAll(artefacts, "suggested_reviewers", decodeReviewers)[0]?.value ?? [],
    repoSelection: decodeAll(artefacts, "repo_selection", decodeRepoSelection)[0]?.value ?? null,
  };
}
