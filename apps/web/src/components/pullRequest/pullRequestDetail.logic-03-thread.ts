import type { PullRequestChecksState } from "./pullRequestDetail.logic-02-pull_r.ts";
import {
  GitCommandError,
  PullRequestDetail,
  PullRequestOperationError,
  type PullRequestAction,
  type PullRequestActor,
  type PullRequestBaseComparison,
  type PullRequestCheck,
  type PullRequestChecksState as ContractPullRequestChecksState,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestContextMetadata,
  type PullRequestDetailView,
  type PullRequestMergeability,
  type PullRequestReaction,
  type PullRequestMergeMethod,
  type PullRequestRef,
  type RepositoryIdentity,
  type PullRequestReviewThread,
  type PullRequestState,
  type PullRequestUpdateMethod,
  SourceControlProviderKind,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type VcsRef,
} from "@t3tools/contracts";
import { inferReviewCommentFenceLanguage, type ReviewCommentContext } from "~/reviewCommentContext";

export type ThreadPanelPullRequestAction = "resolve" | "ready" | "fix" | "merge";

export type PullRequestReviewOutcome = "approved" | "changes-requested" | "dismissed";

/** Normalize host verdict formats; ignore non-verdict review states. */
export interface PullRequestReviewOutcomeEntry {
  readonly key: string;
  readonly actor: PullRequestActor | null;
  readonly outcome: PullRequestReviewOutcome;
  readonly at: string;
  readonly stale: boolean;
}

export interface PullRequestTimelineEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: "opened" | "commit" | "comment" | "review" | "merged" | "closed";
  readonly title: string;
  readonly body: string | null;
  readonly markdown: boolean;
  readonly url: string | null;
  readonly actor: PullRequestActor | null;
  readonly commitAuthors: ReadonlyArray<PullRequestActor>;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly path: string | null;
  readonly reviewState: string | null;
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly comment?: PullRequestComment;
  readonly thread?: PullRequestTimelineThread;
}

export interface PullRequestReplyAvailability {
  readonly moreReplies: number;
  readonly hasMoreReplies: boolean;
  readonly url: string | null;
}

export interface PullRequestTimelineThread
  extends
    Pick<PullRequestReviewThread, "path" | "line" | "isResolved" | "isOutdated">,
    PullRequestReplyAvailability {
  readonly replies: ReadonlyArray<PullRequestTimelineEvent>;
}

export type PullRequestTimelineRow =
  | { readonly kind: "event"; readonly event: PullRequestTimelineEvent }
  | { readonly kind: "comments"; readonly events: ReadonlyArray<PullRequestTimelineEvent> };

export type PullRequestConversationItem =
  | {
      readonly kind: "comment";
      readonly id: string;
      readonly createdAt: string;
      readonly comment: PullRequestComment;
    }
  | ({
      readonly kind: "thread";
      readonly id: string;
      readonly createdAt: string;
      readonly root: PullRequestComment;
      readonly replies: ReadonlyArray<PullRequestComment>;
      readonly thread: PullRequestReviewThread;
    } & PullRequestReplyAvailability);

export interface FixFindingsHandoff {
  readonly prompt: string;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
}

export type PullRequestFinding =
  | { readonly kind: "thread"; readonly thread: PullRequestReviewThread }
  | { readonly kind: "check"; readonly check: PullRequestCheck }
  | { readonly kind: "comment"; readonly comment: PullRequestComment };

export type SnapshotStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface PullRequestDetailSnapshotRef {
  readonly host?: string | undefined;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
}

