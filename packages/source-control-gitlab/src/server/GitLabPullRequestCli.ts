import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  PullRequestAction,
  PullRequestActor,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
} from "@t3tools/contracts";

import { type GitLabMergeRequestDetail } from "./gitLabMergeRequestJson.ts";
import type {
  ProviderFileStats,
  ProviderListCursor,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import {
  type GitLabPullRequestCliError,
  type GitLabMergeRequestListBatch,
  type GitLabMergeRequestDiffSlice,
} from "./gitLabPullRequestCliSupport.ts";
import { makeGitLabCliApi } from "./gitLabPullRequestCliApi.ts";
import { makeGitLabCliStats } from "./gitLabPullRequestCliStats.ts";
import { makeGitLabPullRequestCliService } from "./gitLabPullRequestCliService.ts";

export * from "./gitLabPullRequestCliSupport.ts";

export class GitLabPullRequestCli extends Context.Service<
  GitLabPullRequestCli,
  {
    readonly getViewerUsername: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
    }) => Effect.Effect<string, GitLabPullRequestCliError>;

    readonly listMergeRequests: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<GitLabMergeRequestListBatch, GitLabPullRequestCliError>;

    readonly getMergeRequestDetail: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      /** `false` skips the trigger job read; the permission check before every write does. */
      readonly downstreamChecks?: boolean;
    }) => Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError>;

    readonly getReviewDecisions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly numbers: ReadonlyArray<number>;
    }) => Effect.Effect<
      ReadonlyMap<number, PullRequestReviewDecision | null>,
      GitLabPullRequestCliError
    >;

    /** Line counts for the given merge requests; one with no answer is left out. */
    readonly listMergeRequestStats: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly changeRequests: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
      }>;
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
        readonly additions: number;
        readonly deletions: number;
      }>,
      GitLabPullRequestCliError
    >;

    readonly getMergeRequestFileStats: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ProviderFileStats, GitLabPullRequestCliError>;

    readonly listNotes: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly comments: ReadonlyArray<PullRequestComment>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly listCommits: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, GitLabPullRequestCliError>;

    readonly getMergeRequestDiff: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly cursor?: string | undefined;
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitLabMergeRequestDiffSlice, GitLabPullRequestCliError>;

    readonly getMergeRequestDiffFileContents: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      GitLabPullRequestCliError
    >;

    readonly getProjectMergeCapabilities: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
    }) => Effect.Effect<PullRequestMergeCapabilities, GitLabPullRequestCliError>;

    readonly getFileRevisions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly paths: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitLabPullRequestCliError>;

    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitLabPullRequestCliError>;

    readonly listProjectLabels: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly search?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestLabel>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly listProjectUsers: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly search?: string | undefined;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<PullRequestActor>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{ readonly id: string }>;
      readonly requested: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly runMergeRequestAction: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly updateMergeRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly description?: string | undefined;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly commentOnMergeRequest: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly updateNote: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly noteId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly listDiscussions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      { readonly threads: ReadonlyArray<PullRequestReviewThread>; readonly truncated: boolean },
      GitLabPullRequestCliError
    >;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly replyToDiscussion: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly discussionId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly setDiscussionResolution: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly discussionId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;

    readonly listReactions: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<
      {
        readonly reactions: ReadonlyArray<PullRequestReaction>;
        readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
      },
      GitLabPullRequestCliError
    >;

    readonly setReaction: (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
      readonly noteId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitLabPullRequestCliError>;
  }
>()("@t3tools/source-control-gitlab/server/GitLabPullRequestCli") {}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeGitLabCliApi;
  const client = makeGitLabCliStats(api);
  return makeGitLabPullRequestCliService(client);
});

export const layer = Layer.effect(GitLabPullRequestCli, make);
