import { IssueListSort } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { IssueCapabilities, IssueViewerPermissions } from "@t3tools/contracts";

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import type { GitHubIssueViewerAccess } from "./gitHubIssueJson.ts";
import {
  IssueProviderError,
  type IssueAdapter,
  type ProviderIssueDetail,
} from "./IssueProvider.ts";

const CAPABILITIES: IssueCapabilities = {
  sorts: IssueListSort.literals,
  referenceStyle: "hash",
  closesViaPullRequest: true,
  comment: true,
  actions: ["close", "reopen"],
  closeReasons: ["completed", "not-planned"],
  create: true,
  issueTemplates: true,
  edit: true,
  editComment: true,
  reactions: true,
  labels: true,
  assignees: true,
  listLabelCandidates: true,
  listAssigneeCandidates: true,
  search: true,
  linkedPullRequests: true,
  timelineEvents: true,
};

/**
 * What the signed-in account may do here, from the three things GitHub says about it.
 *
 * Closing, reopening and editing go by `viewerCanUpdate`, which GitHub grants the author of an
 * issue as well as anyone who can write to the repository: somebody who filed an issue may retitle
 * it and close it again without any access to the code.
 *
 * Labelling and assigning need a role instead, and the softest role that has them is triage —
 * which exists for exactly this. An author with no role gets neither, which is what GitHub itself
 * shows them.
 *
 * Commenting and filing are not gated at all: being able to see a repository whose tracker is on
 * is being able to say something in it, and that is what an issue tracker is for.
 */
function gitHubIssueViewerPermissions(access: GitHubIssueViewerAccess): IssueViewerPermissions {
  return {
    actions: access.canUpdate ? (["close", "reopen"] as const) : [],
    comment: true,
    edit: access.canUpdate,
    labels: access.canTriage,
    assignees: access.canTriage,
    create: true,
  };
}

/** The CLI tags that mean the tool itself is unusable, or that this repository keeps no issues,
 *  rather than one request failing. */
function reasonFor(error: GitHubIssueCli.GitHubIssueCliError): IssueProviderError["reason"] {
  if (error._tag === "GitHubCliMissingError") return "missing-tool";
  if (
    error._tag === "GitHubApiAuthenticationError" ||
    error._tag === "GitHubNotSignedInError" ||
    error._tag === "GitHubHostDisabledError"
  )
    return "unauthenticated";
  if (error._tag === "GitHubIssuesDisabledError") return "tracker-disabled";
  if (
    error._tag === "GitHubApiRateLimitError" ||
    error._tag === "SourceControlRateLimitPausedError"
  )
    return "rate-limited";
  return "failed";
}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubIssueCli.GitHubIssueCli;
  const api = yield* GitHubApi.GitHubApi;

  const fail = (operation: string) => (error: GitHubIssueCli.GitHubIssueCliError) =>
    new IssueProviderError({
      provider: "github",
      operation,
      reason: reasonFor(error),
      detail: "detail" in error ? error.detail : error.message,
      ...((error._tag === "GitHubApiRateLimitError" ||
        error._tag === "SourceControlRateLimitPausedError") &&
      error.retryAt !== undefined
        ? { retryAt: error.retryAt }
        : {}),
      cause: error,
    });

  const provider: IssueAdapter = {
    kind: "github",
    capabilities: CAPABILITIES,
    candidatePermissionsIncluded: true,
    withCredential: (host, read) =>
      api.credential(host).pipe(
        Effect.mapError(fail("credential")),
        Effect.flatMap(({ token, fingerprint }) =>
          read(fingerprint).pipe(
            Effect.provideService(GitHubApi.PinnedGitHubCredential, {
              host: host.toLowerCase(),
              token,
              credentialFingerprint: fingerprint,
            }),
            Effect.provideService(SourceControlRateLimit.CredentialScope, fingerprint),
          ),
        ),
      ),

    getViewer: (input) => cli.getViewerLogin(input).pipe(Effect.mapError(fail("getViewer"))),

    listIssues: (input) =>
      cli
        .listIssues({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          sort: input.sort,
          order: input.order,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(Effect.mapError(fail("listIssues"))),

    /** The same listing for a whole host in one search, which is what a GitHub listing usually is:
     *  the per-repository read above is what answers for a repository the index does not cover. */
    listIssuesAcross: (input) =>
      cli
        .searchIssues({
          cwd: input.cwd,
          host: input.host,
          repositories: input.repositories,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          sort: input.sort,
          order: input.order,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(Effect.mapError(fail("listIssuesAcross"))),

    getIssueSummary: (input) =>
      cli.getIssueSummary(input).pipe(Effect.mapError(fail("getIssueSummary"))),

    getIssue: (input) =>
      cli.getIssueDetail(input).pipe(
        Effect.mapError(fail("getIssue")),
        Effect.map((issue): ProviderIssueDetail => ({
          ...issue,
          repositoryUrl: new URL(input.repository, `${new URL(issue.url).origin}/`).toString(),
          viewer: issue.viewerLogin,
          viewerPermissions: gitHubIssueViewerPermissions(issue.viewerAccess),
        })),
      ),

    getIssueActivity: (input) =>
      cli.getIssueActivity(input).pipe(Effect.mapError(fail("getIssueActivity"))),

    getIssueComments: (input) =>
      cli.getIssueComments(input).pipe(Effect.mapError(fail("getIssueComments"))),

    getViewerPermissions: (input) =>
      cli
        .getViewerAccess(input)
        .pipe(
          Effect.mapError(fail("getViewerPermissions")),
          Effect.map(gitHubIssueViewerPermissions),
        ),

    runAction: (input) =>
      cli
        .runIssueAction({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          action: input.action,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) => cli.commentOnIssue(input).pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) => cli.updateComment(input).pipe(Effect.mapError(fail("updateComment"))),

    setReaction: (input) => cli.setReaction(input).pipe(Effect.mapError(fail("setReaction"))),

    create: (input) => cli.createIssue(input).pipe(Effect.mapError(fail("create"))),

    update: (input) =>
      cli
        .updateIssue({
          cwd: input.cwd,
          repository: input.repository,
          host: input.host,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        })
        .pipe(Effect.mapError(fail("update"))),

    setLabels: (input) => cli.setLabels(input).pipe(Effect.mapError(fail("setLabels"))),

    setAssignees: (input) => cli.setAssignees(input).pipe(Effect.mapError(fail("setAssignees"))),

    listLabelCandidates: (input) =>
      cli.listLabelCandidates(input).pipe(Effect.mapError(fail("listLabelCandidates"))),

    listAssigneeCandidates: (input) =>
      cli.listAssigneeCandidates(input).pipe(Effect.mapError(fail("listAssigneeCandidates"))),

    listIssueTemplates: (input) =>
      cli.listIssueTemplates(input).pipe(Effect.mapError(fail("listIssueTemplates"))),
  };

  return provider;
});
