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

export class LinearNotConnectedError extends Schema.TaggedErrorClass<LinearNotConnectedError>()(
  "LinearNotConnectedError",
  {
    operation: LinearApiOperation,
  },
) {
  override get message(): string {
    return `Linear API failed in ${this.operation}: Linear is not connected.`;
  }
}

export class LinearRequestError extends Schema.TaggedErrorClass<LinearRequestError>()(
  "LinearRequestError",
  {
    operation: LinearApiOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Linear API failed in ${this.operation}: Failed to send the Linear request.`;
  }
}

export class LinearHttpError extends Schema.TaggedErrorClass<LinearHttpError>()("LinearHttpError", {
  operation: LinearApiOperation,
  status: Schema.Int,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Linear API failed in ${this.operation}: Linear returned HTTP ${this.status}.`;
  }
}

export class LinearGraphqlError extends Schema.TaggedErrorClass<LinearGraphqlError>()(
  "LinearGraphqlError",
  {
    operation: LinearApiOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Linear API failed in ${this.operation}: Linear returned a GraphQL error.`;
  }
}

export class LinearResponseDecodeError extends Schema.TaggedErrorClass<LinearResponseDecodeError>()(
  "LinearResponseDecodeError",
  {
    operation: LinearApiOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Linear API failed in ${this.operation}: Linear returned an unexpected response.`;
  }
}

export class LinearEmptyResponseError extends Schema.TaggedErrorClass<LinearEmptyResponseError>()(
  "LinearEmptyResponseError",
  {
    operation: LinearApiOperation,
  },
) {
  override get message(): string {
    return `Linear API failed in ${this.operation}: Linear returned no data.`;
  }
}

export class LinearIssueNotFoundError extends Schema.TaggedErrorClass<LinearIssueNotFoundError>()(
  "LinearIssueNotFoundError",
  {
    operation: LinearApiOperation,
    issueId: Schema.String,
  },
) {
  override get message(): string {
    return `Linear API failed in ${this.operation}: Linear issue ${this.issueId} was not found.`;
  }
}

export const LinearApiError = Schema.Union([
  LinearNotConnectedError,
  LinearRequestError,
  LinearHttpError,
  LinearGraphqlError,
  LinearResponseDecodeError,
  LinearEmptyResponseError,
  LinearIssueNotFoundError,
]);
export type LinearApiError = typeof LinearApiError.Type;
export const isLinearApiError = Schema.is(LinearApiError);
