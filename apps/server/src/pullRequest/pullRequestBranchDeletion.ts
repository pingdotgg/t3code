import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PullRequestBranchDeletionError extends Schema.TaggedErrorClass<PullRequestBranchDeletionError>()(
  "PullRequestBranchDeletionError",
  {
    reason: Schema.Literals([
      "invalid-response",
      "not-finished",
      "protected-branch",
      "source-repository-missing",
      "source-branch-missing",
      "delete-refused",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get detail(): string {
    switch (this.reason) {
      case "invalid-response":
        return "The host did not return enough branch data to delete the source branch safely.";
      case "not-finished":
        return "Close or merge the pull request before deleting its source branch.";
      case "protected-branch":
        return "The default branch or target branch cannot be deleted.";
      case "source-repository-missing":
        return "The source repository no longer exists.";
      case "source-branch-missing":
        return "The source branch has already been deleted or is no longer accessible.";
      case "delete-refused":
        return "The host refused to delete the source branch. It may have changed, already been deleted, be protected, or be unavailable to this account. Refresh the pull request before trying again.";
    }
  }

  override get message(): string {
    return this.detail;
  }
}

export const assertSourceBranchDeletable = (input: {
  readonly state: string;
  readonly sourceRepository: string;
  readonly baseRepository: string;
  readonly sourceBranch: string;
  readonly baseBranch: string;
  readonly defaultBranch: string;
}) => {
  const state = input.state.toLowerCase();
  const reason =
    !input.sourceRepository.trim() ||
    !input.baseRepository.trim() ||
    !input.sourceBranch.trim() ||
    !input.baseBranch.trim() ||
    !input.defaultBranch.trim()
      ? "invalid-response"
      : !["closed", "merged", "declined", "superseded", "completed", "abandoned"].includes(state)
        ? "not-finished"
        : (input.sourceRepository === input.baseRepository &&
              input.sourceBranch === input.baseBranch) ||
            input.sourceBranch === input.defaultBranch
          ? "protected-branch"
          : null;
  return reason === null
    ? Effect.void
    : Effect.fail(new PullRequestBranchDeletionError({ reason }));
};

export const decodeBranchDeletionJson = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: S,
  raw: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (cause) =>
        new PullRequestBranchDeletionError({
          reason: "invalid-response",
          cause,
        }),
    ),
  );
