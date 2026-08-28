import * as Effect from "effect/Effect";
import type { IssueCapabilities, IssueViewerPermissions } from "@t3tools/contracts";

import * as GitLabIssueCli from "./GitLabIssueCli.ts";
import {
  IssueProviderError,
  type IssueAdapter,
  type ProviderIssueActivity,
  type ProviderIssueDetail,
} from "./IssueProvider.ts";

const CAPABILITIES: IssueCapabilities = {
  comment: true,
  actions: ["close", "reopen"],
  // GitLab records nothing about why an issue was closed, so a close never asks for a reason.
  closeReasons: [],
  create: true,
  // Markdown files under `.gitlab/issue_templates/` and nothing else: GitLab has no typed form, so
  // its templates carry a body for the reader to write over and never a list of questions.
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
 * What the signed-in account may do here — which for GitLab is everything, because its issue
 * payload answers none of these questions. There is no `user` block on an issue the way there is
 * on a merge request, and the viewer's project role says nothing about the two things that
 * actually decide this: a reporter may close and reopen the issues they opened, and a guest may
 * comment on an issue they can see.
 *
 * So the controls stay offered and GitLab explains any refusal itself, which is the better of the
 * two mistakes: a control that is not there tells the one person entitled to it nothing.
 */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  actions: CAPABILITIES.actions,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
  create: true,
};

/** The CLI tags that mean the tool itself is unusable, rather than one request failing. */
function reasonFor(error: GitLabIssueCli.GitLabIssueCliError): IssueProviderError["reason"] {
  if (error._tag === "GitLabCliUnavailableError") return "missing-tool";
  if (error._tag === "GitLabCliAuthenticationError") return "unauthenticated";
  // Never `tracker-disabled`: GitLab answers a project with its issues switched off with the same
  // 404 as a mistyped path or a deleted issue, so claiming the tracker is off would explain a
  // typo as a setting nobody changed.
  return "failed";
}

export const make = Effect.gen(function* () {
  const cli = yield* GitLabIssueCli.GitLabIssueCli;

  const fail = (operation: string) => (error: GitLabIssueCli.GitLabIssueCliError) =>
    new IssueProviderError({
      provider: "gitlab",
      operation,
      reason: reasonFor(error),
      detail: error.detail,
      cause: error,
    });

  const provider: IssueAdapter = {
    kind: "gitlab",
    capabilities: CAPABILITIES,

    getViewer: (input) =>
      cli.getViewerUsername({ cwd: input.cwd }).pipe(Effect.mapError(fail("getViewer"))),

    listIssues: (input) =>
      cli
        .listIssues({
          cwd: input.cwd,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listIssues")),
          // GitLab is asked for its issues by update, newest first, whether or not it is being
          // carried on from — so every page it answers is one a cursor can continue.
          Effect.map(({ items, truncated }) => ({ items, truncated, continues: true })),
        ),

    getIssue: (input) =>
      Effect.all([cli.getIssueDetail(input), cli.listLinkedMergeRequests(input)], {
        concurrency: 2,
      }).pipe(
        Effect.mapError(fail("getIssue")),
        Effect.map(
          ([issue, linkedPullRequests]): ProviderIssueDetail => ({
            ...issue,
            linkedPullRequests,
            viewerPermissions: VIEWER_PERMISSIONS,
          }),
        ),
      ),

    getIssueActivity: (input) =>
      cli.listActivity(input).pipe(
        Effect.mapError(fail("getIssueActivity")),
        Effect.map(
          (activity): ProviderIssueActivity => ({
            comments: activity.comments,
            // The issue's own `user_notes_count` is on a read this one does not make, and reading
            // the issue again to learn a number the walk already has is a request for nothing:
            // the notes endpoint carries every remark, and it is read until GitLab runs out.
            commentCount: activity.comments.length,
            commentsTruncated: activity.truncated,
            events: activity.events,
            reactions: activity.reactions,
          }),
        ),
      ),

    // No request at all: nothing GitLab reports about an issue narrows what this viewer may ask
    // for, so there is nothing to read and re-reading the issue would only cost a round trip.
    getViewerPermissions: () => Effect.succeed(VIEWER_PERMISSIONS),

    // The reason is dropped rather than passed on: `closeReasons` is empty, so a close never
    // carries one, and GitLab has nowhere to record it.
    runAction: (input) =>
      cli
        .runIssueAction({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          action: input.action,
        })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) => cli.commentOnIssue(input).pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) => cli.updateComment(input).pipe(Effect.mapError(fail("updateComment"))),

    setReaction: (input) => cli.setReaction(input).pipe(Effect.mapError(fail("setReaction"))),

    create: (input) =>
      cli
        .createIssue({
          cwd: input.cwd,
          repository: input.repository,
          title: input.title,
          body: input.body,
          labels: input.labels,
          assignees: input.assignees,
        })
        .pipe(Effect.mapError(fail("create"))),

    update: (input) =>
      cli
        .updateIssue({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          title: input.title,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("update"))),

    setLabels: (input) =>
      cli
        .setLabels({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          labels: input.labels,
        })
        .pipe(Effect.mapError(fail("setLabels"))),

    setAssignees: (input) =>
      cli
        .setAssignees({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
          assignees: input.assignees,
        })
        .pipe(Effect.mapError(fail("setAssignees"))),

    listLabelCandidates: (input) =>
      cli
        .listLabelCandidates({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
        })
        .pipe(Effect.mapError(fail("listLabelCandidates"))),

    listAssigneeCandidates: (input) =>
      cli
        .listAssigneeCandidates({
          cwd: input.cwd,
          repository: input.repository,
          number: input.number,
        })
        .pipe(Effect.mapError(fail("listAssigneeCandidates"))),

    listIssueTemplates: (input) =>
      cli
        .listIssueTemplates({ cwd: input.cwd, repository: input.repository })
        .pipe(Effect.mapError(fail("listIssueTemplates"))),
  };

  return provider;
});
