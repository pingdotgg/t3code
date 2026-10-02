import type { CollaborativeAcceptanceRecord, PullRequestRef, ThreadId } from "@t3tools/contracts";

export type AcceptanceCaseLookupSelection =
  | { readonly _tag: "selected"; readonly record: CollaborativeAcceptanceRecord }
  | { readonly _tag: "not-found" }
  | {
      readonly _tag: "ambiguous";
      readonly caseIds: ReadonlyArray<CollaborativeAcceptanceRecord["case"]["caseId"]>;
    };

const samePullRequest = (left: PullRequestRef, right: PullRequestRef): boolean =>
  left.projectId === right.projectId &&
  left.repository === right.repository &&
  left.number === right.number;

const isNonterminal = (record: CollaborativeAcceptanceRecord): boolean =>
  record.projection.acceptanceLifecycle !== "accepted";

/** Select an active case for an already-authorized parent thread. */
export const selectCurrentAcceptanceCase = (input: {
  readonly records: ReadonlyArray<CollaborativeAcceptanceRecord>;
  readonly threadId: ThreadId;
  readonly pullRequest: PullRequestRef;
}): AcceptanceCaseLookupSelection => {
  const active = input.records
    .filter(
      (record) =>
        record.case.parentThreadId === input.threadId &&
        samePullRequest(record.case.pullRequest, input.pullRequest) &&
        isNonterminal(record),
    )
    .sort((left, right) => left.case.caseId.localeCompare(right.case.caseId));

  if (active.length === 0) return { _tag: "not-found" };
  if (active.length > 1) {
    return {
      _tag: "ambiguous",
      caseIds: active.map((record) => record.case.caseId),
    };
  }
  return { _tag: "selected", record: active[0]! };
};

/** Resolve the authoritative case parent from the PR identity, never association provenance. */
export const selectCurrentAcceptanceCaseForPullRequest = (input: {
  readonly records: ReadonlyArray<CollaborativeAcceptanceRecord>;
  readonly pullRequest: PullRequestRef;
}): AcceptanceCaseLookupSelection => {
  const active = input.records
    .filter(
      (record) =>
        samePullRequest(record.case.pullRequest, input.pullRequest) && isNonterminal(record),
    )
    .sort((left, right) => left.case.caseId.localeCompare(right.case.caseId));

  if (active.length === 0) return { _tag: "not-found" };
  if (active.length > 1) {
    return {
      _tag: "ambiguous",
      caseIds: active.map((record) => record.case.caseId),
    };
  }
  return { _tag: "selected", record: active[0]! };
};
