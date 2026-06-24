import { Effect } from "effect";

import {
  GitManagerError,
  type GitListPullRequestsResult,
  type PullRequestCheck,
  type PullRequestSummary,
} from "@t3tools/contracts";
import type { GitHubPullRequestListEntry } from "../Services/GitHubCli.ts";
import type { GitHubCliShape } from "../Services/GitHubCli.ts";
import type { GitHubCliError } from "../Services/GitHubCli.ts";
import type { GitManagerShape } from "../GitManager.ts";

/** Map GitHubCliError → GitManagerError so PR methods satisfy GitManagerServiceError. */
function wrapGhError<A>(
  cwd: string,
  effect: Effect.Effect<A, GitHubCliError>,
): Effect.Effect<A, GitManagerError> {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new GitManagerError({
          operation: error.operation,
          cwd,
          detail: error.detail,
          cause: error,
        }),
    ),
  );
}

function extractFileDiff(fullDiff: string, filePath: string): string {
  const marker = `diff --git a/${filePath} b/${filePath}`;
  const lines = fullDiff.split("\n");
  let inSection = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (inSection) break;
      if (line === marker) {
        inSection = true;
      }
    }
    if (inSection) {
      collected.push(line);
    }
  }
  return collected.length > 0 ? `${collected.join("\n")}\n` : "";
}

function toPullRequestSummary(
  entry: GitHubPullRequestListEntry,
  currentUser: string,
): PullRequestSummary {
  const normalizedUser = currentUser.toLowerCase();
  const hasMyApproval =
    normalizedUser.length > 0 &&
    entry.reviews.some(
      (review) => review.author.toLowerCase() === normalizedUser && review.state === "APPROVED",
    );
  const hasMyComment =
    normalizedUser.length > 0 &&
    entry.reviews.some(
      (review) =>
        review.author.toLowerCase() === normalizedUser &&
        (review.state === "COMMENTED" || review.state === "CHANGES_REQUESTED"),
    );
  const checks: ReadonlyArray<PullRequestCheck> = entry.statusCheckRollup.map((check) => ({
    name: check.name,
    status: check.status,
  }));
  const checksTotal = checks.length;
  const checksPassing = checks.filter((c) => c.status === "pass").length;
  const checksFailing = checks.filter((c) => c.status === "fail").length;
  const checksPending = checks.filter((c) => c.status === "pending").length;
  const state = entry.state.trim().length > 0 ? entry.state : "OPEN";
  const author = entry.author.trim();
  const authorAvatar = author.length > 0 ? `https://github.com/${author}.png?size=40` : "";
  return {
    number: entry.number,
    title: entry.title,
    url: entry.url,
    state,
    isDraft: entry.isDraft,
    updatedAt: entry.updatedAt,
    headRefName: entry.headRefName,
    author,
    authorAvatar,
    hasMyApproval,
    hasMyComment,
    checksTotal,
    checksPassing,
    checksFailing,
    checksPending,
    checks,
  };
}

type PRMethods = Pick<
  GitManagerShape,
  | "listPullRequests"
  | "getPullRequestDiff"
  | "getPullRequestFileDiff"
  | "getPullRequestReviewComments"
  | "getPullRequestIssueComments"
  | "getPullRequestBody"
  | "postPullRequestReviewComment"
  | "postPullRequestIssueComment"
  | "getPullRequestViewedFiles"
  | "setPullRequestFileViewed"
  | "submitPullRequestReview"
  | "mergePullRequest"
  | "getPullRequestDetail"
  | "editPullRequest"
  | "getRepositoryCollaborators"
>;

export function makeGitManagerPRMethods(gitHubCli: GitHubCliShape): PRMethods {
  const fetchCurrentUserLogin = (cwd: string) =>
    gitHubCli.execute({ cwd, args: ["api", "user", "--jq", ".login"] }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.catch(() => Effect.succeed("")),
    );

  const listPullRequests: PRMethods["listPullRequests"] = (input) =>
    wrapGhError(
      input.cwd,
      Effect.gen(function* () {
        const [rawResult, currentUser] = yield* Effect.all(
          [
            gitHubCli.listWorkspacePullRequests({ cwd: input.cwd }),
            fetchCurrentUserLogin(input.cwd),
          ],
          { concurrency: 2 },
        );

        if (!rawResult.ghAvailable) {
          return {
            reviewRequested: [],
            myPrs: [],
            ghAvailable: false,
            error: rawResult.error,
          } satisfies GitListPullRequestsResult;
        }

        return {
          reviewRequested: rawResult.reviewRequested.map((entry: GitHubPullRequestListEntry) =>
            toPullRequestSummary(entry, currentUser),
          ),
          myPrs: rawResult.myPrs.map((entry: GitHubPullRequestListEntry) =>
            toPullRequestSummary(entry, currentUser),
          ),
          ghAvailable: true,
          error: rawResult.error,
        } satisfies GitListPullRequestsResult;
      }),
    );

  const getPullRequestDiff: PRMethods["getPullRequestDiff"] = (input) =>
    wrapGhError(
      input.cwd,
      Effect.gen(function* () {
        const diff = yield* gitHubCli.getPullRequestDiff({
          cwd: input.cwd,
          prNumber: input.prNumber,
        });
        return { files: diff.files, fullDiff: diff.fullDiff };
      }),
    );

  const getPullRequestFileDiff: PRMethods["getPullRequestFileDiff"] = (input) =>
    wrapGhError(
      input.cwd,
      Effect.gen(function* () {
        const diff = yield* gitHubCli.getPullRequestDiff({
          cwd: input.cwd,
          prNumber: input.prNumber,
        });
        return { diff: extractFileDiff(diff.fullDiff, input.filePath) };
      }),
    );

  const getPullRequestReviewComments: PRMethods["getPullRequestReviewComments"] = (input) =>
    wrapGhError(
      input.cwd,
      Effect.gen(function* () {
        const comments = yield* gitHubCli.getPullRequestReviewComments({
          cwd: input.cwd,
          prNumber: input.prNumber,
        });
        return { comments };
      }),
    );

  const getPullRequestIssueComments: PRMethods["getPullRequestIssueComments"] = (input) =>
    wrapGhError(
      input.cwd,
      Effect.gen(function* () {
        const comments = yield* gitHubCli.getPullRequestIssueComments({
          cwd: input.cwd,
          prNumber: input.prNumber,
        });
        return { comments };
      }),
    );

  const getPullRequestBody: PRMethods["getPullRequestBody"] = (input) =>
    wrapGhError(
      input.cwd,
      Effect.gen(function* () {
        const result = yield* gitHubCli.getPullRequestBodyHtml({
          cwd: input.cwd,
          prNumber: input.prNumber,
        });
        return { body: result.body, bodyHtml: result.bodyHtml };
      }),
    );

  const postPullRequestReviewComment: PRMethods["postPullRequestReviewComment"] = (input) =>
    wrapGhError(
      input.cwd,
      gitHubCli.postPullRequestReviewComment({
        cwd: input.cwd,
        prNumber: input.prNumber,
        body: input.body,
        path: input.path,
        line: input.line,
      }),
    );

  const postPullRequestIssueComment: PRMethods["postPullRequestIssueComment"] = (input) =>
    wrapGhError(
      input.cwd,
      gitHubCli.postPullRequestIssueComment({
        cwd: input.cwd,
        prNumber: input.prNumber,
        body: input.body,
      }),
    );

  const getPullRequestViewedFiles: PRMethods["getPullRequestViewedFiles"] = (input) =>
    wrapGhError(
      input.cwd,
      Effect.gen(function* () {
        const viewedPaths = yield* gitHubCli.getPullRequestViewedFiles({
          cwd: input.cwd,
          prNumber: input.prNumber,
        });
        return { viewedPaths };
      }),
    );

  const setPullRequestFileViewed: PRMethods["setPullRequestFileViewed"] = (input) =>
    wrapGhError(
      input.cwd,
      gitHubCli.setPullRequestFileViewed({
        cwd: input.cwd,
        prNumber: input.prNumber,
        path: input.path,
        viewed: input.viewed,
      }),
    );

  const submitPullRequestReview: PRMethods["submitPullRequestReview"] = (input) =>
    wrapGhError(
      input.cwd,
      gitHubCli.submitPullRequestReview({
        cwd: input.cwd,
        prNumber: input.prNumber,
        event: input.event,
        ...(input.body !== undefined ? { body: input.body } : {}),
      }),
    );

  const mergePullRequest: PRMethods["mergePullRequest"] = (input) =>
    wrapGhError(
      input.cwd,
      gitHubCli.mergePullRequest({
        cwd: input.cwd,
        prNumber: input.prNumber,
        method: input.method,
        ...(input.deleteBranch !== undefined ? { deleteBranch: input.deleteBranch } : {}),
        ...(input.autoMerge !== undefined ? { autoMerge: input.autoMerge } : {}),
      }),
    );

  const getPullRequestDetail: PRMethods["getPullRequestDetail"] = (input) =>
    wrapGhError(
      input.cwd,
      gitHubCli.getPullRequestDetail({
        cwd: input.cwd,
        prNumber: input.prNumber,
      }),
    );

  const editPullRequest: PRMethods["editPullRequest"] = (input) =>
    wrapGhError(
      input.cwd,
      gitHubCli.editPullRequest({
        cwd: input.cwd,
        prNumber: input.prNumber,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.addLabels !== undefined ? { addLabels: input.addLabels } : {}),
        ...(input.removeLabels !== undefined ? { removeLabels: input.removeLabels } : {}),
        ...(input.addAssignees !== undefined ? { addAssignees: input.addAssignees } : {}),
        ...(input.removeAssignees !== undefined ? { removeAssignees: input.removeAssignees } : {}),
        ...(input.addReviewers !== undefined ? { addReviewers: input.addReviewers } : {}),
        ...(input.removeReviewers !== undefined ? { removeReviewers: input.removeReviewers } : {}),
        ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
      }),
    );

  const getRepositoryCollaborators: PRMethods["getRepositoryCollaborators"] = (input) =>
    wrapGhError(
      input.cwd,
      Effect.gen(function* () {
        const collaborators = yield* gitHubCli.getRepositoryCollaborators({
          cwd: input.cwd,
        });
        return { collaborators };
      }),
    );

  return {
    listPullRequests,
    getPullRequestDiff,
    getPullRequestFileDiff,
    getPullRequestReviewComments,
    getPullRequestIssueComments,
    getPullRequestBody,
    postPullRequestReviewComment,
    postPullRequestIssueComment,
    getPullRequestViewedFiles,
    setPullRequestFileViewed,
    submitPullRequestReview,
    mergePullRequest,
    getPullRequestDetail,
    editPullRequest,
    getRepositoryCollaborators,
  };
}
