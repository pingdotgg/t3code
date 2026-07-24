import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

export interface NormalizedGitHubIssueRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
}

const GitHubIssueSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: Schema.String,
  labels: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
    }),
  ),
  assignees: Schema.Array(
    Schema.Struct({
      login: TrimmedNonEmptyString,
    }),
  ),
});

const decodeGitHubIssue = decodeJsonResult(GitHubIssueSchema);

export function decodeGitHubIssueJson(
  raw: string,
): Result.Result<NormalizedGitHubIssueRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubIssue(raw);
  if (!Result.isSuccess(result)) {
    return Result.fail(result.failure);
  }

  return Result.succeed({
    number: result.success.number,
    title: result.success.title,
    url: result.success.url,
    state: result.success.state.trim().toUpperCase() === "CLOSED" ? "closed" : "open",
    labels: result.success.labels.map((label) => label.name),
    assignees: result.success.assignees.map((assignee) => assignee.login),
  });
}
