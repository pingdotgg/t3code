import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface GitHubPrDetail {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "merged" | "closed";
  readonly headSha: string | null;
  readonly reviewDecision: "none" | "changes_requested" | "approved";
  readonly ciState: "pending" | "success" | "failure";
}

export interface GitHubReviewItem {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly submittedAt: string;
}

export interface GitHubPortShape {
  readonly preflight: (
    cwd: string,
  ) => Effect.Effect<{ ok: true } | { ok: false; reason: string }, WorkflowEventStoreError>;
  readonly resolveRemote: (
    cwd: string,
  ) => Effect.Effect<{ remoteName: string; repo: string }, WorkflowEventStoreError>;
  readonly defaultBranch: (cwd: string) => Effect.Effect<string, WorkflowEventStoreError>;
  readonly openPr: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
  }) => Effect.Effect<{ number: number; url: string; adopted: boolean }, WorkflowEventStoreError>;
  readonly prDetail: (input: {
    readonly cwd: string;
    readonly prNumber: number;
  }) => Effect.Effect<GitHubPrDetail, WorkflowEventStoreError>;
  // Read-only: find an existing open PR for a branch WITHOUT pushing or
  // creating one. Used by recovery to adopt a PR that was created before the
  // crash but never recorded via TicketPrOpened.
  readonly findPrForBranch: (input: {
    readonly cwd: string;
    readonly branch: string;
  }) => Effect.Effect<{ number: number; url: string } | null, WorkflowEventStoreError>;
  readonly mergePr: (input: {
    readonly cwd: string;
    readonly prNumber: number;
    readonly strategy: "squash" | "merge" | "rebase";
    readonly deleteBranch: boolean;
    readonly branch: string;
    readonly remoteName: string;
  }) => Effect.Effect<{ ok: true } | { ok: false; reason: string }, WorkflowEventStoreError>;
  readonly failingCheckLogs: (input: {
    readonly cwd: string;
    readonly prNumber: number;
  }) => Effect.Effect<string | null, WorkflowEventStoreError>;
  readonly listReviewFeedback: (input: {
    readonly cwd: string;
    readonly prNumber: number;
    readonly repo: string;
  }) => Effect.Effect<ReadonlyArray<GitHubReviewItem>, WorkflowEventStoreError>;
}

export class GitHubPort extends Context.Service<GitHubPort, GitHubPortShape>()(
  "t3/workflow/Services/GitHubPort",
) {}
