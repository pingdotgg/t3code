import type {
  LinearCustomView,
  LinearIssue,
  LinearIssueDetail,
  LinearIssueFilter,
  LinearMilestone,
  LinearOrganization,
  LinearProject,
  LinearTeam,
  LinearTeamMetadata,
  LinearViewer,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { IssueTrackerError } from "./errors.ts";

/** Limits Linear reported on the last response. Used to back off before the hard 429. */
export interface RateLimitObservation {
  readonly remaining: number | null;
  /** Epoch milliseconds when the window resets. */
  readonly resetsAtMs: number | null;
}

export interface IssueListPage {
  readonly issues: ReadonlyArray<LinearIssue>;
  /** True when the per-list cap cut the results. */
  readonly truncated: boolean;
}

type Call<A> = Effect.Effect<A, IssueTrackerError>;

/** Read and write operations T3 needs from an issue tracker. */
export interface IssueTracker {
  readonly verify: Call<{
    readonly viewer: LinearViewer;
    readonly organization: LinearOrganization;
  }>;
  readonly teams: Call<ReadonlyArray<LinearTeam>>;
  readonly teamMetadata: (teamId: string) => Call<LinearTeamMetadata>;
  readonly projects: (teamId: string | undefined) => Call<ReadonlyArray<LinearProject>>;
  readonly milestones: (projectId: string) => Call<ReadonlyArray<LinearMilestone>>;
  readonly issues: (filter: LinearIssueFilter) => Call<IssueListPage>;
  readonly issue: (issueId: string) => Call<LinearIssue>;
  readonly issueDetail: (issueId: string) => Call<LinearIssueDetail>;
  readonly subIssues: (issueId: string) => Call<ReadonlyArray<LinearIssue>>;
  readonly views: Call<ReadonlyArray<LinearCustomView>>;
  readonly search: (term: string) => Call<ReadonlyArray<LinearIssue>>;
  readonly moveIssueToState: (issueId: string, stateId: string) => Call<void>;
  readonly createComment: (issueId: string, body: string) => Call<{ readonly id: string }>;
  readonly updateComment: (commentId: string, body: string) => Call<void>;
}
