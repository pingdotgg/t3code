import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CourseKind = Schema.Literals(["ocw", "youtube", "pdf", "ours"]);
export type CourseKind = typeof CourseKind.Type;

const Prepared = Schema.Struct({ plan: Schema.Boolean, quiz: Schema.Boolean });
export const CourseId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
export const CourseUnit = Schema.Struct({
  title: TrimmedNonEmptyString,
  youtubeId: Schema.optional(Schema.String),
  pages: Schema.optional(Schema.Tuple([Schema.Int, Schema.Int])),
  hasText: Schema.Boolean,
  prepared: Prepared,
  section: Schema.optional(Schema.String),
});
export type CourseUnit = typeof CourseUnit.Type;

export const CourseProblemSet = Schema.Struct({
  title: TrimmedNonEmptyString,
  section: Schema.optional(Schema.String),
  hasSolution: Schema.Boolean,
  workedExampleUnits: Schema.optional(Schema.Array(Schema.Int)),
  references: Schema.optional(
    Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String })),
  ),
});
export type CourseProblemSet = typeof CourseProblemSet.Type;

export const CourseProblemReference = Schema.Struct({
  label: Schema.String,
  url: Schema.String,
  answers: Schema.String,
});
export type CourseProblemReference = typeof CourseProblemReference.Type;

export const CoursePosition = Schema.Struct({
  unit: Schema.Int,
  at: Schema.optional(Schema.Number),
});
export type CoursePosition = typeof CoursePosition.Type;

export const Course = Schema.Struct({
  id: CourseId,
  kind: CourseKind,
  title: TrimmedNonEmptyString,
  source: Schema.optional(Schema.String),
  license: Schema.optional(Schema.String),
  attribution: Schema.optional(Schema.String),
  lessonThreadId: ThreadId,
  createdAt: Schema.String,
  units: Schema.Array(CourseUnit),
  problemSets: Schema.optional(Schema.Array(CourseProblemSet)),
  solutionSearchedAt: Schema.optional(Schema.String),
  position: Schema.optional(CoursePosition),
  prepThreadIds: Schema.Array(ThreadId),
});
export type Course = typeof Course.Type;

export const CourseSummary = Schema.Struct({
  id: CourseId,
  kind: CourseKind,
  title: TrimmedNonEmptyString,
  unitCount: Schema.Int,
  position: Schema.optional(CoursePosition),
  attribution: Schema.optional(Schema.String),
});
export type CourseSummary = typeof CourseSummary.Type;

export class CourseError extends Schema.TaggedError<CourseError>()("CourseError", {
  message: Schema.String,
}) {}
