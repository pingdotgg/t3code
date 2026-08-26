/**
 * Decoding for the artefact types the report header renders. PostHog keeps
 * artefact content open-ended, so each type is decoded leniently and anything
 * that does not match is skipped rather than failing the whole report.
 */
import * as Effect from "effect/Effect";
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

/**
 * A `note` artefact: an update appended after the report was written, often
 * by a scout that found fresher evidence. These are the most current thing on
 * a report and routinely change its diagnosis.
 */
const PostHogReportNote = Schema.Struct({
  note: Schema.String,
  author: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type PostHogReportNote = typeof PostHogReportNote.Type;

const decodeFinding = Schema.decodeUnknownOption(PostHogSignalFinding);
const decodePriority = Schema.decodeUnknownOption(PostHogPriorityAssessment);
const decodeActionability = Schema.decodeUnknownOption(PostHogActionabilityAssessment);
const decodeCodeReference = Schema.decodeUnknownOption(PostHogCodeReference);
const decodeReviewers = Schema.decodeUnknownOption(PostHogSuggestedReviewers);
const decodeRepoSelection = Schema.decodeUnknownOption(PostHogRepoSelection);
const decodeNote = Schema.decodeUnknownOption(PostHogReportNote);

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
  /** Newest first: an update appended after the report was written. */
  readonly notes: ReadonlyArray<{
    readonly id: string;
    readonly createdAt: string;
    readonly value: PostHogReportNote;
  }>;
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
    // The scout that authors a report leaves a bookkeeping note saying so;
    // it tells the reader nothing the page does not already show.
    notes: artefacts
      .filter((artefact) => artefact.type === "note")
      .flatMap((artefact) =>
        Option.toArray(decodeNote(artefact.content)).map((value) => ({
          id: artefact.id,
          createdAt: artefact.created_at,
          value,
        })),
      )
      .filter(({ value }) => !value.note.trim().startsWith("Authored directly by the")),
  };
}
