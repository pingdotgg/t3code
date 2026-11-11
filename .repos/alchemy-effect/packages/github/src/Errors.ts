import * as Data from "effect/Data";

/** The issue does not exist in the repository. */
export class IssueNotFound extends Data.TaggedError("IssueNotFound")<{
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}> {}
