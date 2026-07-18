import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const LinearIssueSummary = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  stateName: Schema.String,
  stateType: Schema.String,
  teamKey: Schema.String,
});
export type LinearIssueSummary = typeof LinearIssueSummary.Type;

export const LinearIssueComment = Schema.Struct({
  authorName: Schema.NullOr(Schema.String),
  body: Schema.String,
  createdAt: Schema.String,
});
export type LinearIssueComment = typeof LinearIssueComment.Type;

export const LinearIssueDetail = Schema.Struct({
  ...LinearIssueSummary.fields,
  description: Schema.NullOr(Schema.String),
  priorityLabel: Schema.NullOr(Schema.String),
  assigneeName: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  updatedAt: Schema.String,
  comments: Schema.Array(LinearIssueComment),
});
export type LinearIssueDetail = typeof LinearIssueDetail.Type;

export const LinearStatus = Schema.Struct({
  connected: Schema.Boolean,
  viewerName: Schema.optionalKey(Schema.String),
  organizationName: Schema.optionalKey(Schema.String),
});
export type LinearStatus = typeof LinearStatus.Type;

export const LinearSearchIssuesInput = Schema.Struct({
  query: TrimmedString,
  first: Schema.optional(PositiveInt),
});
export type LinearSearchIssuesInput = typeof LinearSearchIssuesInput.Type;

export const LinearGetIssueInput = Schema.Struct({
  issueId: TrimmedNonEmptyString,
});
export type LinearGetIssueInput = typeof LinearGetIssueInput.Type;

export const LinearSearchIssuesResult = Schema.Struct({
  issues: Schema.Array(LinearIssueSummary),
});
export type LinearSearchIssuesResult = typeof LinearSearchIssuesResult.Type;

export const LinearApiOperation = Schema.Literals(["getStatus", "searchIssues", "getIssue"]);
export type LinearApiOperation = typeof LinearApiOperation.Type;

export class LinearApiError extends Schema.TaggedErrorClass<LinearApiError>()("LinearApiError", {
  operation: LinearApiOperation,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
