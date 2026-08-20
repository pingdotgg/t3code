import * as Effect from "effect/Effect";
import type { IssueCapabilities, IssueViewerPermissions } from "@t3tools/contracts";

import * as BitbucketIssueApi from "./BitbucketIssueApi.ts";
import { IssueProviderError, type IssueAdapter, type ProviderIssue } from "./IssueProvider.ts";
import type { BitbucketIssue } from "./bitbucketIssueJson.ts";

const CAPABILITIES: IssueCapabilities = {
  comment: true,
  // Bitbucket's issue tracker spans eight states with no endpoint of its own for moving between
  // them; the closest it offers is writing `state` directly, which only reaches close and reopen.
  actions: ["close", "reopen"],
  // Bitbucket records no reason for closing an issue.
  closeReasons: [],
  create: true,
  // Bitbucket has no issue templates of any kind: its tracker takes a title and a description and
  // offers nothing to start either from.
  issueTemplates: false,
  edit: true,
  editComment: true,
  // Bitbucket has no labels on an issue — `kind` and `priority` are enumerations of their own,
  // not a label set, so nothing here is offered in their place.
  labels: false,
  // One assignee, not a set, but a set of one is still a set the port's write can express.
  assignees: true,
  listLabelCandidates: false,
  // Nothing on a repository lists who could be assigned an issue; only who already is.
  listAssigneeCandidates: false,
  search: true,
  // Bitbucket's issue tracker reports no change requests against an issue.
  linkedPullRequests: false,
  // Nothing beyond the comments themselves is reported: no separate record of closes, reopens or
  // reassignments.
  timelineEvents: false,
};

/**
 * Everything this host offers, narrowed by the one thing Bitbucket states per viewer: the
 * repository permission. Filing, editing, assigning and closing all need `write` or `admin`.
 * Commenting stays open at `read`, which is what posting to the tracker itself needs.
 */
export function bitbucketIssueViewerPermissions(input: {
  readonly canWrite: boolean;
}): IssueViewerPermissions {
  return {
    actions: input.canWrite ? CAPABILITIES.actions : [],
    comment: true,
    edit: input.canWrite,
    labels: false,
    assignees: input.canWrite,
    create: input.canWrite,
  };
}

/**
 * The failures that mean the credentials are the problem, or that this repository's tracker is
 * off, rather than one request. Bitbucket is read over HTTP with credentials from the
 * environment, so there is no tool to be missing: an unusable account always means the
 * credentials are absent or refused.
 */
export function bitbucketIssueErrorReason(
  error: BitbucketIssueApi.BitbucketIssueApiError,
  operation: string,
): IssueProviderError["reason"] {
  if (error._tag !== "BitbucketResponseError") return "failed";
  if (error.status === 401) return "unauthenticated";
  // A switched-off tracker answers 404 on the issues collection itself — `listIssues` and
  // `create` are the only operations that ask it directly. A 404 on one issue by number means
  // only that issue is gone, which is an ordinary failure the reader can act on.
  if (error.status === 404 && (operation === "listIssues" || operation === "create")) {
    return "tracker-disabled";
  }
  return "failed";
}

function toIssue(issue: BitbucketIssue): ProviderIssue {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    author: issue.author,
    state: issue.state,
    stateReason: issue.stateReason,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    assignees: issue.assignee === null ? [] : [issue.assignee],
    labels: [],
    milestone: issue.milestone,
    commentCount: issue.commentCount,
  };
}

export const make = Effect.gen(function* () {
  const api = yield* BitbucketIssueApi.BitbucketIssueApi;

  const fail = (operation: string) => (error: BitbucketIssueApi.BitbucketIssueApiError) =>
    new IssueProviderError({
      provider: "bitbucket",
      operation,
      reason: bitbucketIssueErrorReason(error, operation),
      // Every Bitbucket failure states its own fact; this names the operation around it, so the
      // two do not stack into "failed in x: failed in y: ...".
      detail: error.detail,
      cause: error,
    });

  /** Refuses what the capabilities already say this host cannot do. */
  const unsupported = (operation: string, detail: string) =>
    Effect.fail(
      new IssueProviderError({ provider: "bitbucket", operation, reason: "failed", detail }),
    );

  const provider: IssueAdapter = {
    kind: "bitbucket",
    capabilities: CAPABILITIES,

    // Bitbucket credentials come from the server's environment rather than a checkout, so the
    // account is the same whichever workspace asks.
    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    listIssues: (input) =>
      api
        .listIssues({
          repository: input.repository,
          state: input.state,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listIssues")),
          Effect.map((batch) => ({
            items: batch.items.map(toIssue),
            truncated: batch.truncated,
            // Bitbucket is asked for `-updated_on` whether or not it is being carried on from,
            // so every page it answers is one a cursor can continue.
            continues: true,
          })),
        ),

    getIssue: (input) => {
      const target = { repository: input.repository, number: input.number };
      return Effect.all(
        [api.getIssue(target), api.getRepositoryPermission({ repository: input.repository })],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError(fail("getIssue")),
        Effect.map(([issue, canWrite]) => ({
          ...toIssue(issue),
          body: issue.body,
          // Bitbucket's issue tracker reports no change requests against an issue.
          linkedPullRequests: [],
          viewerPermissions: bitbucketIssueViewerPermissions({ canWrite }),
        })),
      );
    },

    getIssueActivity: (input) =>
      api.listComments({ repository: input.repository, number: input.number }).pipe(
        Effect.mapError(fail("getIssueActivity")),
        Effect.map((page) => ({
          comments: page.comments,
          commentCount: page.comments.length,
          commentsTruncated: page.truncated,
          // Nothing beyond the comments themselves is reported.
          events: [],
        })),
      ),

    getViewerPermissions: (input) =>
      api.getRepositoryPermission({ repository: input.repository }).pipe(
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map((canWrite) => bitbucketIssueViewerPermissions({ canWrite })),
      ),

    runAction: (input) =>
      api
        .runAction({ repository: input.repository, number: input.number, action: input.action })
        .pipe(Effect.mapError(fail("runAction"))),

    comment: (input) =>
      api
        .comment({ repository: input.repository, number: input.number, body: input.body })
        .pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) => api.updateComment(input).pipe(Effect.mapError(fail("updateComment"))),

    create: (input) =>
      api
        .createIssue({
          repository: input.repository,
          title: input.title,
          body: input.body,
          assignee: input.assignees[0] ?? null,
        })
        .pipe(Effect.mapError(fail("create"))),

    update: (input) =>
      api
        .updateIssue({
          repository: input.repository,
          number: input.number,
          title: input.title,
          body: input.body,
        })
        .pipe(Effect.mapError(fail("update"))),

    // Never called: `capabilities.labels` is false, and the service refuses labels without it.
    setLabels: () => unsupported("setLabels", "Bitbucket has no labels to write on an issue."),

    setAssignees: (input) =>
      api
        .setAssignee({
          repository: input.repository,
          number: input.number,
          assignee: input.assignees[0] ?? null,
        })
        .pipe(Effect.mapError(fail("setAssignees"))),

    // Never called: `capabilities.listLabelCandidates` is false.
    listLabelCandidates: () =>
      unsupported("listLabelCandidates", "Bitbucket has no labels to list for an issue."),

    // Never called: `capabilities.listAssigneeCandidates` is false.
    listAssigneeCandidates: () =>
      unsupported(
        "listAssigneeCandidates",
        "Bitbucket lists nobody who could be assigned an issue, only who already is.",
      ),
  };

  return provider;
});
