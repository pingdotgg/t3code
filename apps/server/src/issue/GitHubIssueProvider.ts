import * as Effect from "effect/Effect";
import type { IssueCapabilities, IssueViewerPermissions, IssueActor } from "@t3tools/contracts";

import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import type { GitHubIssueViewerAccess } from "./gitHubIssueJson.ts";
import {
  IssueProviderError,
  type IssueAdapter,
  type ProviderIssueDetail,
} from "./IssueProvider.ts";

const CAPABILITIES: IssueCapabilities = {
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
export function gitHubIssueViewerPermissions(
  access: GitHubIssueViewerAccess,
): IssueViewerPermissions {
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
  if (error._tag === "GitHubCliUnavailableError") return "missing-tool";
  if (error._tag === "GitHubCliAuthenticationError") return "unauthenticated";
  if (error._tag === "GitHubIssuesDisabledError") return "tracker-disabled";
  return "failed";
}

/**
 * `gh issue view --json` reports no avatar for anyone, so the ones the GraphQL read collected are
 * applied here by login. An actor already carrying one keeps it, and a login the read said nothing
 * about keeps its initials rather than a guessed picture.
 */
function withAvatar(
  actor: IssueActor | null,
  avatarsByLogin: ReadonlyMap<string, string>,
): IssueActor | null {
  if (actor === null || actor.avatarUrl !== null) return actor;
  const avatarUrl = avatarsByLogin.get(actor.login);
  return avatarUrl === undefined ? actor : { ...actor, avatarUrl };
}

export const make = Effect.gen(function* () {
  const cli = yield* GitHubIssueCli.GitHubIssueCli;

  const fail = (operation: string) => (error: GitHubIssueCli.GitHubIssueCliError) =>
    new IssueProviderError({
      provider: "github",
      operation,
      reason: reasonFor(error),
      detail: error.detail,
      cause: error,
    });

  const provider: IssueAdapter = {
    kind: "github",
    capabilities: CAPABILITIES,

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

    getIssue: (input) =>
      Effect.all([cli.getIssueDetail(input), cli.getIssueSupplement(input)], {
        concurrency: 2,
      }).pipe(
        Effect.mapError(fail("getIssue")),
        Effect.map(
          ([issue, supplement]): ProviderIssueDetail => ({
            ...issue,
            author: withAvatar(issue.author, supplement.avatarsByLogin),
            assignees: issue.assignees.map(
              (assignee) => withAvatar(assignee, supplement.avatarsByLogin) ?? assignee,
            ),
            commentCount: supplement.commentCount,
            linkedPullRequests: supplement.linkedPullRequests,
            viewerPermissions: gitHubIssueViewerPermissions(supplement.viewer),
          }),
        ),
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
