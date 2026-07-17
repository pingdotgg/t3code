import { Option, SchemaIssue } from "effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ReviewSnapshotScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("uncommitted"),
    branch: Schema.NullOr(TrimmedNonEmptyString),
    untrackedFiles: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("against-base"),
    branch: Schema.NullOr(TrimmedNonEmptyString),
    baseBranch: TrimmedNonEmptyString,
    mergeBaseSha: TrimmedNonEmptyString,
    untrackedFiles: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type ReviewSnapshotScope = typeof ReviewSnapshotScope.Type;

export const ReviewSnapshot = Schema.Struct({
  scope: ReviewSnapshotScope,
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
});
export type ReviewSnapshot = typeof ReviewSnapshot.Type;

export const ReviewFindingPriority = Schema.Literals(["critical", "high", "medium", "low"]);
export type ReviewFindingPriority = typeof ReviewFindingPriority.Type;

export const ReviewFindingLocation = Schema.Struct({
  path: TrimmedNonEmptyString,
  side: Schema.Literals(["new", "old"]),
  startLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  endLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}).check(
  Schema.makeFilter(
    (location) =>
      location.startLine <= location.endLine ||
      new SchemaIssue.InvalidValue(Option.some(location), {
        message: "Review finding startLine must not exceed endLine",
      }),
  ),
);
export type ReviewFindingLocation = typeof ReviewFindingLocation.Type;

export const ReviewFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  priority: ReviewFindingPriority,
  title: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  location: ReviewFindingLocation,
});
export type ReviewFinding = typeof ReviewFinding.Type;

export const ReviewVerdict = Schema.Literals(["approve", "comment", "request-changes"]);
export type ReviewVerdict = typeof ReviewVerdict.Type;

export const ReviewModelOutput = Schema.Struct({
  findings: Schema.Array(ReviewFinding),
  verdict: ReviewVerdict,
  summary: TrimmedNonEmptyString,
});
export type ReviewModelOutput = typeof ReviewModelOutput.Type;

export const ReviewResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("parsed"),
    snapshot: ReviewSnapshot,
    findings: Schema.Array(ReviewFinding),
    verdict: ReviewVerdict,
    summary: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("invalid-output"),
    snapshot: ReviewSnapshot,
    issues: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type ReviewResult = typeof ReviewResult.Type;
