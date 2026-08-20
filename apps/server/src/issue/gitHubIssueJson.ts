import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  ChangeRequestState,
  IssueAssigneeCandidate,
  IssueAssigneeCandidateList,
  IssueCloseReason,
  IssueComment,
  IssueContactLink,
  IssueEvent,
  IssueEventKind,
  IssueLabelCandidate,
  IssueLinkedPullRequest,
  IssueReaction,
  IssueState,
  IssueTemplate,
  IssueTemplateField,
  IssueTemplateList,
  IssueActor,
  IssueLabel,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import {
  GITHUB_REACTION_GROUPS_FIELDS,
  GitHubReactionGroupsSchema,
  toGitHubReactions,
} from "../sourceControl/gitHubReactionJson.ts";

/**
 * Enum-ish GitHub fields are decoded as plain strings and normalized here: a `gh` release or a
 * GraphQL schema addition that brings a new state reason or timeline event must not fail the whole
 * payload.
 */
const RawActorSchema = Schema.Struct({
  /**
   * Optional because a timeline event can be attributed to nobody — an actor GitHub has since
   * deleted answers as null, and an assignment made by an integration names no login at all.
   */
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  /** Only the GraphQL API reports one; `gh issue view --json` has no avatar to give. */
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawMilestoneSchema = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One row as `gh issue list --json` and `gh issue view --json` both spell it. */
const RawIssueSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  /** The empty string on an open issue, which is why this is normalized rather than mapped. */
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(RawActorSchema))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(RawLabelSchema))),
  milestone: Schema.optional(Schema.NullOr(RawMilestoneSchema)),
  reactionGroups: GitHubReactionGroupsSchema,
  body: Schema.optional(Schema.String),
});

/**
 * A search's own answer, which is the listing's row one connection deeper: `gh issue list --json`
 * flattens assignees and labels, and GraphQL does not. Everything below the row is optional
 * because a node that is not an issue decodes as an empty object, which is skipped.
 */
const RawSearchItemSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String }))),
  milestone: Schema.optional(Schema.NullOr(RawMilestoneSchema)),
  reactionGroups: GitHubReactionGroupsSchema,
  comments: Schema.optional(Schema.NullOr(Schema.Struct({ totalCount: Schema.Int }))),
  assignees: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawActorSchema)))),
      }),
    ),
  ),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawLabelSchema)))),
      }),
    ),
  ),
});

/** Where a connection carries on from, which is what the comment and search walks below follow. */
const RawPageInfoSchema = Schema.Struct({
  hasNextPage: Schema.optional(Schema.Boolean),
  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
  hasPreviousPage: Schema.optional(Schema.Boolean),
  startCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawSearchSchema = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      pageInfo: Schema.optional(Schema.NullOr(RawPageInfoSchema)),
      // Row by row, like the listing's own: a node that is not an issue — or one field GitHub
      // changes — is skipped rather than blanking every repository at once.
      nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  }),
});

/**
 * What GitHub says the viewer may do with an issue. Both are optional so that an install that
 * answers without them still delivers the issue they travel with; an absent permission reads as
 * granted, which is what an unknown one is.
 */
const RawViewerFieldsSchema = Schema.Struct({
  viewerCanUpdate: Schema.optional(Schema.Boolean),
  viewerDidAuthor: Schema.optional(Schema.Boolean),
});

/** A change request as a link to it names it, wherever the reference was found. */
const RawReferenceSchema = Schema.Struct({
  __typename: Schema.optional(Schema.NullOr(Schema.String)),
  number: Schema.optional(Schema.NullOr(Schema.Int)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.NullOr(Schema.Boolean)),
  repository: Schema.optional(
    Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

/**
 * Every timeline event as one flat shape. GraphQL answers a union whose members carry different
 * fields, so each of them is optional here and `__typename` is what decides which ones were meant.
 */
const RawTimelineItemSchema = Schema.Struct({
  __typename: Schema.String,
  id: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
  actor: Schema.optional(Schema.NullOr(RawActorSchema)),
  label: Schema.optional(
    Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  assignee: Schema.optional(Schema.NullOr(RawActorSchema)),
  currentTitle: Schema.optional(Schema.NullOr(Schema.String)),
  milestoneTitle: Schema.optional(Schema.NullOr(Schema.String)),
  /** A cross-reference names where it came from; a connection names what was connected. */
  source: Schema.optional(Schema.NullOr(RawReferenceSchema)),
  subject: Schema.optional(Schema.NullOr(RawReferenceSchema)),
});

const RawCommentSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  reactionGroups: GitHubReactionGroupsSchema,
});

const RawCommentsSchema = Schema.Struct({
  totalCount: Schema.optional(Schema.Int),
  pageInfo: Schema.optional(RawPageInfoSchema),
  nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawCommentSchema)))),
});

const RawIssueSupplementSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
      /** Null for a number that names no issue the viewer can see. */
      issue: Schema.NullOr(
        Schema.Struct({
          ...RawViewerFieldsSchema.fields,
          author: Schema.optional(Schema.NullOr(RawActorSchema)),
          assignees: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawActorSchema)))),
              }),
            ),
          ),
          comments: Schema.optional(Schema.NullOr(Schema.Struct({ totalCount: Schema.Int }))),
          closedByPullRequestsReferences: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(
                  Schema.NullOr(Schema.Array(Schema.NullOr(RawReferenceSchema))),
                ),
              }),
            ),
          ),
          timelineItems: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});

const RawViewerPermissionsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
      issue: Schema.NullOr(RawViewerFieldsSchema),
    }),
  }),
});

const RawActivitySchema = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
    repository: Schema.Struct({
      issue: Schema.NullOr(
        Schema.Struct({
          author: Schema.optional(Schema.NullOr(RawActorSchema)),
          reactionGroups: GitHubReactionGroupsSchema,
          comments: Schema.optional(Schema.NullOr(RawCommentsSchema)),
          timelineItems: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});

const RawCommentPageSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
    repository: Schema.Struct({
      issue: Schema.NullOr(Schema.Struct({ comments: Schema.optional(RawCommentsSchema) })),
    }),
  }),
});

const RawAssigneeCandidatesSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      assignableUsers: Schema.Struct({
        pageInfo: Schema.optional(RawPageInfoSchema),
        nodes: Schema.Array(Schema.NullOr(RawActorSchema)),
      }),
      issue: Schema.NullOr(
        Schema.Struct({
          assignees: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawActorSchema)))),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});

/**
 * One of the forms `.github/ISSUE_TEMPLATE/` holds, as GitHub's GraphQL reports it. Every field
 * but the filename is optional there: a template with only a body is a legitimate one.
 */
const RawIssueTemplateSchema = Schema.Struct({
  filename: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  about: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  assignees: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawActorSchema)))),
      }),
    ),
  ),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawLabelSchema)))),
      }),
    ),
  ),
});

const RawIssueTemplatesSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      /** Null for a repository whose templates GitHub will not report, rather than an empty list. */
      issueTemplates: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  }),
});

/** One file of `.github/ISSUE_TEMPLATE/`, with its text where the entry is a file at all. */
const RawTreeEntrySchema = Schema.Struct({
  name: Schema.String,
  object: Schema.optional(
    Schema.NullOr(Schema.Struct({ text: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});

/** Present for a path this repository has, null for one it does not — which is the whole test. */
const RawObjectPresenceSchema = Schema.optional(
  Schema.NullOr(Schema.Struct({ __typename: Schema.optional(Schema.NullOr(Schema.String)) })),
);

const RawIssueTemplateFormsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      url: Schema.optional(Schema.NullOr(Schema.String)),
      /** Null for a repository that keeps no template directory, which is most of them. */
      forms: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            entries: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
          }),
        ),
      ),
      rootGuidelines: RawObjectPresenceSchema,
      dotGitHubGuidelines: RawObjectPresenceSchema,
      docsGuidelines: RawObjectPresenceSchema,
    }),
  }),
});

/**
 * One question of an issue form, as `.github/ISSUE_TEMPLATE/*.yml` writes it. Every attribute is
 * optional because they differ per `type`, and `type` is what decides which ones were meant —
 * the same reason the timeline's union above is one flat shape.
 */
const RawFormFieldSchema = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.NullOr(Schema.String)),
  attributes: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        label: Schema.optional(Schema.NullOr(Schema.String)),
        description: Schema.optional(Schema.NullOr(Schema.String)),
        placeholder: Schema.optional(Schema.NullOr(Schema.String)),
        /** The prose for a `markdown` field, and the prefilled answer for the two that take text. */
        value: Schema.optional(Schema.NullOr(Schema.String)),
        render: Schema.optional(Schema.NullOr(Schema.String)),
        multiple: Schema.optional(Schema.NullOr(Schema.Boolean)),
        /** Plain words for a dropdown, labelled boxes for checkboxes; read per kind below. */
        options: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
      }),
    ),
  ),
  validations: Schema.optional(
    Schema.NullOr(Schema.Struct({ required: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
});

const RawCheckboxOptionSchema = Schema.Struct({
  label: Schema.String,
  required: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

/**
 * A whole issue form. `name` and `body` are the two GitHub's own schema insists on, so a file
 * missing either is not a form and is left to the markdown read — which is where a `.md`
 * template's front matter belongs anyway.
 */
const RawIssueFormSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  /** Written as a list or as one comma-separated line, so neither shape is read as a schema. */
  labels: Schema.optional(Schema.Unknown),
  assignees: Schema.optional(Schema.Unknown),
  body: Schema.Array(Schema.Unknown),
});

/**
 * `.github/ISSUE_TEMPLATE/config.yml`, whose two settings are the rest of what GitHub's own chooser
 * shows. Everything is optional because the file itself is: a repository with templates and no
 * config is the ordinary case.
 */
const RawIssueTemplateConfigSchema = Schema.Struct({
  blank_issues_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  contact_links: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const RawContactLinkSchema = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  about: Schema.optional(Schema.NullOr(Schema.String)),
});

/** What `POST /repos/{owner}/{repo}/issues` answers with, which is all a new issue owes back. */
const RawCreatedIssueSchema = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
});

/**
 * `comments` is deliberately absent: `gh issue list --json comments` answers with every remark's
 * whole body rather than with a count, which is megabytes for a page of busy issues. A row from
 * this read reports no conversation size; the search below carries GitHub's own count instead.
 */
export const ISSUE_LIST_JSON_FIELDS =
  "number,title,url,author,state,stateReason,createdAt,updatedAt,closedAt,assignees,labels,milestone,reactionGroups";

export const ISSUE_DETAIL_JSON_FIELDS = `${ISSUE_LIST_JSON_FIELDS},body`;

/** GitHub's own ceiling on a connection page, which is what every read below asks for. */
const GRAPHQL_PAGE_SIZE = 100;

/**
 * The ceiling on `search`, which refuses anything larger with EXCESSIVE_PAGINATION — the same
 * bound the pull request search runs into.
 */
export const ISSUE_SEARCH_MAX_ROWS = GRAPHQL_PAGE_SIZE;

/**
 * How far GitHub lets a search be paged at all: the thousandth result is the last one it will
 * answer with, whichever way it is asked for. A read that has taken this many rows has taken
 * everything the host has to give for that query, so there is nothing further to carry on to.
 */
export const ISSUE_SEARCH_MAX_RESULTS = 1000;

/** Timeline events kept per issue, newest last. An issue with more history than this is a bot log,
 *  and the recent end of it is the part anybody reads. */
const TIMELINE_ITEMS = GRAPHQL_PAGE_SIZE;

/**
 * Every repository of a host in one read, which is what makes a listing one request rather than
 * one process per repository.
 *
 * `type: ISSUE` is GitHub's own name for the index pull requests and issues share, so the query
 * itself carries `is:issue` and the node is asked for as an `Issue`: without both, a pull request
 * would arrive on the issues page as an issue.
 *
 * The row count is written into the document rather than sent as a variable because every variable
 * here travels as a string — and it is this module's own number, clamped by the caller, never a
 * reader's.
 *
 * `first` on the two inner connections is a bound rather than a page: an issue with more than
 * twenty labels shows twenty, and one assigned to more than twenty people is past what a row says.
 *
 * `after` is how a slice reads on past the page GitHub's ceiling cuts it at, which is what lets one
 * instant holding more issues than a page be handed over whole.
 */
export function issueSearchGraphQlQuery(rows: number): string {
  return `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${Math.min(Math.max(Math.trunc(rows), 1), ISSUE_SEARCH_MAX_ROWS)}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        url
        author { login avatarUrl ... on User { name } }
        state
        stateReason
        createdAt
        updatedAt
        closedAt
        repository { nameWithOwner }
        milestone { title }
        comments { totalCount }
        ${GITHUB_REACTION_GROUPS_FIELDS}
        assignees(first: 20) { nodes { login name avatarUrl } }
        labels(first: 20) { nodes { name color } }
      }
    }
  }
}`;
}

/**
 * Everything about one issue that `gh issue view --json` cannot answer: where the viewer stands,
 * the faces the CLI reports for nobody, the size of the conversation, and the change requests that
 * cite this issue.
 *
 * Links come from two places at once because neither speaks for the other. GitHub records the
 * closing relationship on `closedByPullRequestsReferences`, and it stays there once the change
 * request has merged; `ConnectedEvent` is only written where somebody linked the two by hand, and
 * `DisconnectedEvent` is how that is taken back. Everything else that names the issue is an
 * ordinary cross-reference, which is a mention rather than a promise to close it.
 */
export const ISSUE_SUPPLEMENT_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    issue(number: $number) {
      viewerCanUpdate
      viewerDidAuthor
      author { login avatarUrl }
      assignees(first: 20) { nodes { login name avatarUrl } }
      comments { totalCount }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true, userLinkedOnly: false) {
        nodes { number title url state isDraft repository { nameWithOwner } }
      }
      timelineItems(last: ${TIMELINE_ITEMS}, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT, DISCONNECTED_EVENT]) {
        nodes {
          __typename
          ... on ConnectedEvent {
            subject { __typename ... on PullRequest { number title url state isDraft repository { nameWithOwner } } }
          }
          ... on DisconnectedEvent {
            subject { __typename ... on PullRequest { number repository { nameWithOwner } } }
          }
          ... on CrossReferencedEvent {
            source { __typename ... on PullRequest { number title url state isDraft repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

/**
 * The viewer's standing, asked on its own. Only the write path needs this: reading an issue
 * already carries the same three fields on a call it was making anyway, and this exists so that a
 * close or an edit is decided by what GitHub says now rather than by what the page was told when
 * it loaded.
 */
export const ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    issue(number: $number) { viewerCanUpdate viewerDidAuthor }
  }
}`;

/**
 * The conversation and the history in one read. Both come from GraphQL rather than from
 * `gh issue view --json comments`, which reports no avatar for anybody and cannot reach the
 * timeline at all.
 *
 * The events are the newest hundred: an issue with more state changes than that has been machine
 * driven, and the recent end is the part a reader is looking at. Comments start there too; older
 * pages are read only when the reader asks for them.
 */
export const ISSUE_ACTIVITY_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      author { login avatarUrl }
      ${GITHUB_REACTION_GROUPS_FIELDS}
      comments(last: ${GRAPHQL_PAGE_SIZE}, before: $cursor) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes { id author { login avatarUrl } body createdAt url ${GITHUB_REACTION_GROUPS_FIELDS} }
      }
      timelineItems(last: ${TIMELINE_ITEMS}, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT, MILESTONED_EVENT, LOCKED_EVENT, UNLOCKED_EVENT]) {
        nodes {
          __typename
          ... on ClosedEvent { id createdAt actor { login avatarUrl } }
          ... on ReopenedEvent { id createdAt actor { login avatarUrl } }
          ... on LabeledEvent { id createdAt actor { login avatarUrl } label { name } }
          ... on UnlabeledEvent { id createdAt actor { login avatarUrl } label { name } }
          ... on AssignedEvent { id createdAt actor { login avatarUrl } assignee { ... on User { login name } ... on Bot { login } } }
          ... on UnassignedEvent { id createdAt actor { login avatarUrl } assignee { ... on User { login name } ... on Bot { login } } }
          ... on RenamedTitleEvent { id createdAt actor { login avatarUrl } currentTitle }
          ... on MilestonedEvent { id createdAt actor { login avatarUrl } milestoneTitle }
          ... on LockedEvent { id createdAt actor { login avatarUrl } }
          ... on UnlockedEvent { id createdAt actor { login avatarUrl } }
          ... on CrossReferencedEvent {
            id
            createdAt
            actor { login avatarUrl }
            source { __typename ... on PullRequest { number repository { nameWithOwner } } ... on Issue { number repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

/** The rest of a long conversation, without the history the first page already delivered. */
export const ISSUE_COMMENTS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: ${GRAPHQL_PAGE_SIZE}, before: $cursor) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes { id author { login avatarUrl } body createdAt url ${GITHUB_REACTION_GROUPS_FIELDS} }
      }
    }
  }
}`;

export const ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $commentId: ID!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id } }
  node(id: $commentId) { ... on IssueComment { issue { id } } }
}`;

export const ISSUE_NODE_ID_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id } }
}`;

const RawIssueNodeIdSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({ issue: Schema.Struct({ id: Schema.String }) }),
  }),
});

const decodeIssueNodeId = decodeJsonResult(RawIssueNodeIdSchema);

export function decodeIssueNodeIdJson(raw: string): Result.Result<string, DecodeFailure> {
  const decoded = decodeIssueNodeId(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  return Result.succeed(decoded.success.data.repository.issue.id);
}

const RawIssueCommentScopeSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({ issue: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
    ),
    node: Schema.NullOr(
      Schema.Struct({ issue: Schema.optional(Schema.Struct({ id: Schema.String })) }),
    ),
  }),
});

const decodeIssueCommentScope = decodeJsonResult(RawIssueCommentScopeSchema);

/** A comment id is global, so confirm it hangs off the issue named by the request. */
export function decodeIssueCommentScopeJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeIssueCommentScope(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const expected = decoded.success.data.repository?.issue?.id ?? null;
  const actual = decoded.success.data.node?.issue?.id ?? null;
  return Result.succeed(expected !== null && expected === actual);
}

export const UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION = `mutation($commentId: ID!, $body: String!) {
  updateIssueComment(input: { id: $commentId, body: $body }) { issueComment { id } }
}`;

/**
 * Who this issue may be assigned to, and who it is already assigned to, in one read.
 *
 * `assignableUsers` is the list GitHub's own picker is built from — everyone with access to the
 * repository — rather than `collaborators`, which the REST API refuses to anyone without push
 * access and which would therefore be empty for exactly the reader most likely to be looking.
 */
export const ASSIGNEE_CANDIDATES_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: ${GRAPHQL_PAGE_SIZE}) {
      pageInfo { hasNextPage }
      nodes { login name avatarUrl }
    }
    issue(number: $number) { assignees(first: ${GRAPHQL_PAGE_SIZE}) { nodes { login } } }
  }
}`;

/**
 * As much of a template as a new issue can carry, which is what the create contract accepts:
 * asking for more would read names nothing could then be filed with.
 */
const TEMPLATE_LABELS = 50;
const TEMPLATE_ASSIGNEES = 25;

/**
 * The forms this repository puts in front of somebody filing an issue. Read from the host rather
 * than from the checkout: a working tree sits on whatever branch its reader left it on, and the
 * templates a repository offers are the ones on its default branch.
 */
export const ISSUE_TEMPLATES_GRAPHQL_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issueTemplates {
      filename
      name
      about
      title
      body
      assignees(first: ${TEMPLATE_ASSIGNEES}) { nodes { login } }
      labels(first: ${TEMPLATE_LABELS}) { nodes { name } }
    }
  }
}`;

/**
 * The template directory with every file's text in it, and the paths GitHub itself looks for
 * contributing guidelines at.
 *
 * The forms are read as the files they are because `repository.issueTemplates` above names a form
 * and its labels but says nothing about the questions it asks — a form read through that alone
 * arrives as an empty body, which is a composer that asks none of them. One tree read rather than a
 * request per file, and from `HEAD`, so this stays the same one request against the same branch the
 * markdown templates came from.
 *
 * The three guideline paths are the ones GitHub honours, asked for by presence alone: a link is
 * only worth showing where the file behind it is really there.
 */
export const ISSUE_TEMPLATE_FORMS_GRAPHQL_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    url
    forms: object(expression: "HEAD:.github/ISSUE_TEMPLATE") {
      ... on Tree { entries { name object { ... on Blob { text } } } }
    }
    rootGuidelines: object(expression: "HEAD:CONTRIBUTING.md") { __typename }
    dotGitHubGuidelines: object(expression: "HEAD:.github/CONTRIBUTING.md") { __typename }
    docsGuidelines: object(expression: "HEAD:docs/CONTRIBUTING.md") { __typename }
  }
}`;

/**
 * A GraphQL request as `gh api graphql --input -` takes it. Variables travel in the document
 * rather than as `-f name=value` flags, so a reader's own words never reach argv.
 */
const GraphQlRequestSchema = Schema.Struct({
  query: Schema.String,
  variables: Schema.Record(Schema.String, Schema.String),
});

const encodeGraphQlRequest = Schema.encodeSync(Schema.fromJsonString(GraphQlRequestSchema));

export function encodeGraphQlRequestJson(input: {
  readonly query: string;
  readonly variables: Readonly<Record<string, string>>;
}): string {
  return encodeGraphQlRequest({ query: input.query, variables: { ...input.variables } });
}

/**
 * The body of `POST /repos/{owner}/{repo}/issues` and of the `PATCH` that edits one. Every write
 * takes the same road because a title and a body are the reader's own words either way, and the
 * REST API is the only one of GitHub's that accepts both without putting them in argv —
 * `gh issue create --title` and `gh issue edit --title` cannot.
 *
 * Labels and assignees are the whole set rather than a change to it, which is what this endpoint
 * writes: an empty array takes all of them off.
 */
const IssueWriteSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  assignees: Schema.optional(Schema.Array(Schema.String)),
});

const encodeIssueWrite = Schema.encodeSync(Schema.fromJsonString(IssueWriteSchema));

export interface IssueWriteFields {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly assignees?: ReadonlyArray<string> | undefined;
}

export function buildIssueWriteJson(input: IssueWriteFields): string {
  return encodeIssueWrite({
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
  });
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: IssueActor | null;
  readonly state: IssueState;
  readonly stateReason: IssueCloseReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly assignees: ReadonlyArray<IssueActor>;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly milestone: string | null;
  readonly commentCount: number;
  readonly reactions: ReadonlyArray<IssueReaction>;
}

export interface GitHubIssueDetail extends GitHubIssue {
  readonly body: string;
}

export interface GitHubIssueSearchItem extends GitHubIssue {
  /** `owner/name` as GitHub spells it, which is how a row from a search finds its repository. */
  readonly repository: string;
}

/** Everything one GraphQL read adds to the issue `gh issue view --json` already answered with. */
export interface GitHubIssueSupplement {
  readonly viewer: GitHubIssueViewerAccess;
  /** Avatars by login, for the actors `gh issue view --json` reports without one — which is all
   *  of them, since no `gh` JSON field carries an avatar. */
  readonly avatarsByLogin: ReadonlyMap<string, string>;
  readonly commentCount: number;
  readonly linkedPullRequests: ReadonlyArray<IssueLinkedPullRequest>;
}

/**
 * Everything GitHub says about what the signed-in account may do here. `canTriage` is about the
 * repository, the other two about this issue in particular — which is why the author of an issue
 * can still be told apart from a passer-by.
 */
export interface GitHubIssueViewerAccess {
  /** A role that can label, assign and milestone. Triage exists for exactly that. */
  readonly canTriage: boolean;
  /** GitHub's own `viewerCanUpdate`, true for the author as well as for anyone with write. */
  readonly canUpdate: boolean;
  readonly didAuthor: boolean;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Null once a connection has nothing further, which is what ends the comment walk. GitHub sends an
 * `endCursor` on a page that is also the last one, so the flag is what decides, not the cursor.
 */
function nextCursorOf(
  pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null | undefined,
): string | null {
  return pageInfo?.hasNextPage === true ? trimmed(pageInfo.endCursor) : null;
}

/** Where a newest-first connection carries on into older rows. */
function previousCursorOf(
  pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | null | undefined,
): string | null {
  return pageInfo?.hasPreviousPage === true ? trimmed(pageInfo.startCursor) : null;
}

function toActor(
  raw: Schema.Schema.Type<typeof RawActorSchema> | null | undefined,
): IssueActor | null {
  const login = trimmed(raw?.login);
  return login === null
    ? null
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatarUrl) };
}

function toActors(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawActorSchema> | null> | null | undefined,
): ReadonlyArray<IssueActor> {
  return (raw ?? []).flatMap((entry) => {
    const actor = toActor(entry);
    return actor === null ? [] : [actor];
  });
}

function toLabels(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawLabelSchema> | null> | null | undefined,
): ReadonlyArray<IssueLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label?.name);
    return name === null ? [] : [{ name, color: trimmed(label?.color) }];
  });
}

/** GitHub answers the empty string for an open issue and `REOPENED` for one opened again, and
 *  neither is a reason a closed issue was closed for. */
function toStateReason(value: string | null | undefined): IssueCloseReason | null {
  switch (value?.trim().toUpperCase()) {
    case "COMPLETED":
      return "completed";
    case "NOT_PLANNED":
      return "not-planned";
    default:
      return null;
  }
}

function toState(value: string | null | undefined): IssueState {
  return value?.trim().toUpperCase() === "CLOSED" ? "closed" : "open";
}

/**
 * The viewer's standing on one issue. The halves take opposite defaults on purpose.
 *
 * Updating is a permission, so an install that does not report it grants it and lets the host's own
 * refusal explain anything that fails. Authorship is not a permission but a fact about who wrote
 * the thing, so an unknown answer is "not the author", which grants nothing it should not. A role
 * the host named nothing for is no role, because labelling somebody else's issue is not something
 * to offer a reader who cannot do it.
 */
function toViewerAccess(raw: {
  readonly viewerPermission?: string | null | undefined;
  readonly issue: Schema.Schema.Type<typeof RawViewerFieldsSchema> | null;
}): GitHubIssueViewerAccess {
  switch (raw.viewerPermission?.trim().toUpperCase()) {
    case "ADMIN":
    case "MAINTAIN":
    case "WRITE":
    case "TRIAGE":
      return {
        canTriage: true,
        canUpdate: raw.issue?.viewerCanUpdate !== false,
        didAuthor: raw.issue?.viewerDidAuthor === true,
      };
    default:
      return {
        canTriage: false,
        canUpdate: raw.issue?.viewerCanUpdate !== false,
        didAuthor: raw.issue?.viewerDidAuthor === true,
      };
  }
}

function toChangeRequestState(value: string | null | undefined): ChangeRequestState {
  switch (value?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return "open";
  }
}

/** Where a reference is filed, which is what makes two sightings of one change request one link. */
function referenceKey(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

/**
 * A change request as a link to it, or null for a reference to anything else — an issue that cites
 * this one is a mention between issues rather than the work that answers it.
 */
function toLinkedPullRequest(
  raw: Schema.Schema.Type<typeof RawReferenceSchema> | null | undefined,
  closesIssue: boolean,
): IssueLinkedPullRequest | null {
  if (raw == null) return null;
  // Absent on `closedByPullRequestsReferences`, whose nodes are pull requests by definition.
  const typename = trimmed(raw.__typename);
  if (typename !== null && typename !== "PullRequest") return null;
  const repository = trimmed(raw.repository?.nameWithOwner);
  const title = trimmed(raw.title);
  const url = trimmed(raw.url);
  const number = raw.number ?? 0;
  if (repository === null || title === null || url === null || number <= 0) return null;
  return {
    repository,
    number,
    title,
    url,
    state: toChangeRequestState(raw.state),
    isDraft: raw.isDraft ?? false,
    closesIssue,
  };
}

/**
 * The change GitHub recorded, or null for an event kind this page has no vocabulary for. Anything
 * unmapped is dropped rather than guessed at — a timeline missing an entry is better than one
 * asserting the wrong thing happened.
 */
function toEventFields(
  raw: Schema.Schema.Type<typeof RawTimelineItemSchema>,
): { readonly kind: IssueEventKind; readonly detail: string | null } | null {
  switch (raw.__typename) {
    case "ClosedEvent":
      return { kind: "closed", detail: null };
    case "ReopenedEvent":
      return { kind: "reopened", detail: null };
    case "LabeledEvent":
      return { kind: "labeled", detail: trimmed(raw.label?.name) };
    case "UnlabeledEvent":
      return { kind: "unlabeled", detail: trimmed(raw.label?.name) };
    case "AssignedEvent":
      return { kind: "assigned", detail: trimmed(raw.assignee?.login) };
    case "UnassignedEvent":
      return { kind: "unassigned", detail: trimmed(raw.assignee?.login) };
    case "RenamedTitleEvent":
      return { kind: "renamed", detail: trimmed(raw.currentTitle) };
    case "MilestonedEvent":
      return { kind: "milestoned", detail: trimmed(raw.milestoneTitle) };
    case "LockedEvent":
      return { kind: "locked", detail: null };
    case "UnlockedEvent":
      return { kind: "unlocked", detail: null };
    case "CrossReferencedEvent": {
      const repository = trimmed(raw.source?.repository?.nameWithOwner);
      const number = raw.source?.number ?? 0;
      return {
        kind: "referenced",
        detail: repository === null || number <= 0 ? null : `${repository}#${number}`,
      };
    }
    default:
      return null;
  }
}

function toIssue(raw: Schema.Schema.Type<typeof RawIssueSchema>): GitHubIssue {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: toActor(raw.author),
    state: toState(raw.state),
    stateReason: toStateReason(raw.stateReason),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    closedAt: trimmed(raw.closedAt),
    assignees: toActors(raw.assignees),
    labels: toLabels(raw.labels),
    milestone: trimmed(raw.milestone?.title),
    // The listing has no count that is not the whole conversation; the search below has one.
    commentCount: 0,
    reactions: toGitHubReactions(raw.reactionGroups, null),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeIssueEntry = Schema.decodeUnknownExit(RawIssueSchema);
const decodeIssue = decodeJsonResult(RawIssueSchema);
const decodeSearch = decodeJsonResult(RawSearchSchema);
const decodeSearchItem = Schema.decodeUnknownExit(RawSearchItemSchema);
const decodeTimelineItem = Schema.decodeUnknownExit(RawTimelineItemSchema);
const decodeSupplement = decodeJsonResult(RawIssueSupplementSchema);
const decodeViewerPermissions = decodeJsonResult(RawViewerPermissionsSchema);
const decodeActivity = decodeJsonResult(RawActivitySchema);
const decodeCommentPage = decodeJsonResult(RawCommentPageSchema);
const decodeAssigneeCandidates = decodeJsonResult(RawAssigneeCandidatesSchema);
const decodeLabelEntry = Schema.decodeUnknownExit(RawLabelSchema);
const decodeCreatedIssue = decodeJsonResult(RawCreatedIssueSchema);
const decodeIssueTemplates = decodeJsonResult(RawIssueTemplatesSchema);
const decodeIssueTemplateEntry = Schema.decodeUnknownExit(RawIssueTemplateSchema);
const decodeIssueTemplateForms = decodeJsonResult(RawIssueTemplateFormsSchema);
const decodeTreeEntry = Schema.decodeUnknownExit(RawTreeEntrySchema);
const decodeIssueForm = Schema.decodeUnknownExit(RawIssueFormSchema);
const decodeFormField = Schema.decodeUnknownExit(RawFormFieldSchema);
const decodeCheckboxOption = Schema.decodeUnknownExit(RawCheckboxOptionSchema);
const decodeIssueTemplateConfig = Schema.decodeUnknownExit(RawIssueTemplateConfigSchema);
const decodeContactLinkEntry = Schema.decodeUnknownExit(RawContactLinkSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface GitHubIssueListBatch {
  readonly items: ReadonlyArray<GitHubIssue>;
  /** Rows gh returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch: one unexpected issue must not
 *  blank the whole list. */
export function decodeIssueListJson(
  raw: string,
): Result.Result<GitHubIssueListBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: GitHubIssue[] = [];
  for (const entry of decoded.success) {
    const item = decodeIssueEntry(entry);
    if (Exit.isSuccess(item)) items.push(toIssue(item.value));
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

export function decodeIssueDetailJson(
  raw: string,
): Result.Result<GitHubIssueDetail, DecodeFailure> {
  const decoded = decodeIssue(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ ...toIssue(decoded.success), body: decoded.success.body ?? "" })
    : Result.fail(decoded.failure);
}

export function decodeCreatedIssueJson(
  raw: string,
): Result.Result<{ readonly number: number; readonly url: string }, DecodeFailure> {
  const decoded = decodeCreatedIssue(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({ number: decoded.success.number, url: decoded.success.html_url })
    : Result.fail(decoded.failure);
}

export interface GitHubIssueSearchBatch {
  /** Rows across every repository asked for, newest update first, each naming its own. */
  readonly items: ReadonlyArray<GitHubIssueSearchItem>;
  /** Rows the search returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
  /** More rows than this slice asked for, which is truncation for every repository in it. */
  readonly hasNextPage: boolean;
  /** Where the next page of the same search starts, or null once the search has nothing further. */
  readonly nextCursor: string | null;
}

/**
 * A search answers with the same issue the listing does, one connection deeper: assignees and
 * labels arrive as connections, the row names the repository it came from, and GitHub's own count
 * of the conversation comes with it. Flattened to the shape `gh issue list --json` hands over so
 * both reads decode into one type.
 *
 * Rows that are not issues decode as empty and are skipped, the way a malformed listing row is —
 * `is:issue` and the `... on Issue` fragment already exclude them, and one surprise must not blank
 * a whole host.
 */
export function decodeIssueSearchJson(
  raw: string,
): Result.Result<GitHubIssueSearchBatch, DecodeFailure> {
  const decoded = decodeSearch(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const nodes = decoded.success.data.search.nodes ?? [];
  const items: GitHubIssueSearchItem[] = [];
  for (const entry of nodes) {
    const decodedNode = decodeSearchItem(entry);
    if (!Exit.isSuccess(decodedNode)) continue;
    const node = decodedNode.value;
    const repository = trimmed(node.repository?.nameWithOwner);
    if (repository === null) continue;
    items.push({
      ...toIssue({
        ...node,
        assignees: toActors(node.assignees?.nodes),
        labels: (node.labels?.nodes ?? []).flatMap((label) => (label === null ? [] : [label])),
      }),
      commentCount: Math.max(0, node.comments?.totalCount ?? 0),
      repository,
    });
  }
  const pageInfo = decoded.success.data.search.pageInfo;
  return Result.succeed({
    items,
    rawCount: nodes.length,
    hasNextPage: pageInfo?.hasNextPage ?? false,
    nextCursor: nextCursorOf(pageInfo),
  });
}

export function decodeIssueSupplementJson(
  raw: string,
): Result.Result<GitHubIssueSupplement, DecodeFailure> {
  const decoded = decodeSupplement(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const repository = decoded.success.data.repository;
  const issue = repository.issue;
  const avatarsByLogin = new Map<string, string>();
  for (const actor of [issue?.author, ...(issue?.assignees?.nodes ?? [])]) {
    const login = trimmed(actor?.login);
    const avatarUrl = trimmed(actor?.avatarUrl);
    if (login !== null && avatarUrl !== null) avatarsByLogin.set(login, avatarUrl);
  }

  // Whoever GitHub says closes the issue leads, then the hand-made connections still standing,
  // then the mentions — so a change request seen twice is filed under the stronger relationship.
  const links = new Map<string, IssueLinkedPullRequest>();
  for (const node of issue?.closedByPullRequestsReferences?.nodes ?? []) {
    const link = toLinkedPullRequest(node, true);
    if (link !== null) links.set(referenceKey(link.repository, link.number), link);
  }
  const connected = new Map<string, IssueLinkedPullRequest>();
  const mentions = new Map<string, IssueLinkedPullRequest>();
  for (const entry of issue?.timelineItems?.nodes ?? []) {
    const decodedItem = decodeTimelineItem(entry);
    if (!Exit.isSuccess(decodedItem)) continue;
    const item = decodedItem.value;
    if (item.__typename === "ConnectedEvent") {
      const link = toLinkedPullRequest(item.subject, true);
      if (link !== null) connected.set(referenceKey(link.repository, link.number), link);
      continue;
    }
    // In timeline order, so a link made, dropped and made again ends up as it stands today.
    if (item.__typename === "DisconnectedEvent") {
      const repository = trimmed(item.subject?.repository?.nameWithOwner);
      const number = item.subject?.number ?? 0;
      if (repository !== null && number > 0) connected.delete(referenceKey(repository, number));
      continue;
    }
    const link = toLinkedPullRequest(item.source, false);
    if (link !== null) mentions.set(referenceKey(link.repository, link.number), link);
  }
  for (const [key, link] of [...connected, ...mentions]) {
    if (!links.has(key)) links.set(key, link);
  }

  return Result.succeed({
    viewer: toViewerAccess(repository),
    avatarsByLogin,
    commentCount: Math.max(0, issue?.comments?.totalCount ?? 0),
    linkedPullRequests: [...links.values()],
  });
}

export function decodeIssueViewerPermissionsJson(
  raw: string,
): Result.Result<GitHubIssueViewerAccess, DecodeFailure> {
  const decoded = decodeViewerPermissions(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toViewerAccess(decoded.success.data.repository))
    : Result.fail(decoded.failure);
}

export interface GitHubIssueActivityPage {
  /** Richer than the listing's author: this read carries the avatar no `gh` JSON field does. */
  readonly author: IssueActor | null;
  readonly comments: ReadonlyArray<IssueComment>;
  /** GitHub's own count of the conversation, which a bounded read can fall short of. */
  readonly commentCount: number;
  /** Where the rest of the conversation carries on from, or null once it is whole. */
  readonly nextCursor: string | null;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly reactions: ReturnType<typeof toGitHubReactions>;
}

function toComments(
  raw: Schema.Schema.Type<typeof RawCommentsSchema> | null | undefined,
  viewer: string | null,
): ReadonlyArray<IssueComment> {
  return (raw?.nodes ?? []).flatMap((comment) => {
    const id = trimmed(comment?.id);
    if (comment == null || id === null) return [];
    return [
      {
        id,
        author: toActor(comment.author),
        body: comment.body ?? "",
        createdAt: comment.createdAt,
        url: trimmed(comment.url),
        reactions: toGitHubReactions(comment.reactionGroups, viewer),
      },
    ];
  });
}

/** One page of the conversation, with the history the first page carries alongside it. */
export function decodeIssueActivityJson(
  raw: string,
): Result.Result<GitHubIssueActivityPage, DecodeFailure> {
  const decoded = decodeActivity(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const issue = decoded.success.data.repository.issue;
  const viewer = trimmed(decoded.success.data.viewer?.login);
  const events: IssueEvent[] = [];
  for (const entry of issue?.timelineItems?.nodes ?? []) {
    const decodedItem = decodeTimelineItem(entry);
    if (!Exit.isSuccess(decodedItem)) continue;
    const item = decodedItem.value;
    const fields = toEventFields(item);
    const id = trimmed(item.id);
    const createdAt = trimmed(item.createdAt);
    if (fields === null || id === null || createdAt === null) continue;
    events.push({
      id,
      kind: fields.kind,
      actor: toActor(item.actor),
      createdAt,
      detail: fields.detail,
    });
  }
  return Result.succeed({
    author: toActor(issue?.author),
    comments: toComments(issue?.comments, viewer),
    commentCount: Math.max(0, issue?.comments?.totalCount ?? 0),
    nextCursor: previousCursorOf(issue?.comments?.pageInfo),
    events,
    reactions: toGitHubReactions(issue?.reactionGroups, viewer),
  });
}

/** The rest of one conversation, in the shape the first page already delivered it. */
export function decodeIssueCommentsJson(raw: string): Result.Result<
  {
    readonly comments: ReadonlyArray<IssueComment>;
    readonly nextCursor: string | null;
  },
  DecodeFailure
> {
  const decoded = decodeCommentPage(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const comments = decoded.success.data.repository.issue?.comments;
  const viewer = trimmed(decoded.success.data.viewer?.login);
  return Result.succeed({
    comments: toComments(comments, viewer),
    nextCursor: previousCursorOf(comments?.pageInfo),
  });
}

export interface GitHubRepositoryLabels {
  /** Nothing is marked applied here: which labels the issue has lives on the issue. */
  readonly labels: ReadonlyArray<Omit<IssueLabelCandidate, "isApplied">>;
  readonly rawCount: number;
}

export function decodeRepositoryLabelsJson(
  raw: string,
): Result.Result<GitHubRepositoryLabels, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const labels: Array<Omit<IssueLabelCandidate, "isApplied">> = [];
  for (const entry of decoded.success) {
    const label = decodeLabelEntry(entry);
    if (Exit.isFailure(label)) continue;
    const name = trimmed(label.value.name);
    if (name === null) continue;
    labels.push({
      name,
      color: trimmed(label.value.color),
      description: label.value.description ?? null,
    });
  }
  return Result.succeed({ labels, rawCount: decoded.success.length });
}

/**
 * The people this issue may be assigned to, with whoever already has it marked. Anyone assigned
 * leads the list even where GitHub no longer counts them assignable — somebody whose access was
 * taken away is still assigned, and an assignment that cannot be seen cannot be taken back.
 */
export function decodeAssigneeCandidatesJson(
  raw: string,
): Result.Result<IssueAssigneeCandidateList, DecodeFailure> {
  const decoded = decodeAssigneeCandidates(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const repository = decoded.success.data.repository;
  const candidates = new Map<string, IssueAssigneeCandidate>();
  for (const node of repository.issue?.assignees?.nodes ?? []) {
    const actor = toActor(node);
    // GitHub addresses an assignee by the same login it shows, so the id is the handle itself.
    if (actor !== null)
      candidates.set(actor.login, { ...actor, id: actor.login, isAssigned: true });
  }
  for (const node of repository.assignableUsers.nodes) {
    const actor = toActor(node);
    if (actor === null || candidates.has(actor.login)) continue;
    candidates.set(actor.login, { ...actor, id: actor.login, isAssigned: false });
  }
  return Result.succeed({
    candidates: [...candidates.values()],
    truncated: repository.assignableUsers.pageInfo?.hasNextPage === true,
  });
}

/**
 * The templates this repository offers, in the order it lists them. A template that cannot be read
 * is skipped rather than failing the read: one malformed form must not take away the others, nor
 * the blank issue that filing falls back to.
 */
export function decodeIssueTemplatesJson(
  raw: string,
): Result.Result<ReadonlyArray<IssueTemplate>, DecodeFailure> {
  const decoded = decodeIssueTemplates(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const templates: Array<IssueTemplate> = [];
  for (const entry of decoded.success.data.repository.issueTemplates ?? []) {
    const template = decodeIssueTemplateEntry(entry);
    if (Exit.isFailure(template)) continue;
    const key = trimmed(template.value.filename);
    if (key === null) continue;
    templates.push({
      key,
      // A template with no `name:` is offered under its filename, which is what GitHub shows too.
      name: trimmed(template.value.name) ?? key,
      about: template.value.about ?? "",
      title: template.value.title ?? "",
      body: template.value.body ?? "",
      labels: (template.value.labels?.nodes ?? []).flatMap((node) => {
        const name = trimmed(node?.name);
        return name === null ? [] : [name];
      }),
      assignees: (template.value.assignees?.nodes ?? []).flatMap((node) => {
        const login = trimmed(node?.login);
        return login === null ? [] : [login];
      }),
    });
  }
  return Result.succeed(templates);
}

/**
 * The names a form wrote, however it wrote them: GitHub's schema takes a YAML list and a single
 * comma-separated line, and a form using the second is not a broken one. Anything that is not a
 * word is dropped, so one stray entry cannot cost a form its labels.
 */
function toNameList(value: unknown): ReadonlyArray<string> {
  const written: unknown = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(written)) return [];
  const entries: ReadonlyArray<unknown> = written;
  return entries.flatMap((entry) => {
    const name = typeof entry === "string" ? trimmed(entry) : null;
    return name === null ? [] : [name];
  });
}

/**
 * One question of a form, or null for one this composer has no control for. An unknown kind is
 * dropped rather than guessed at: a question rendered as the wrong thing files the wrong answer,
 * and the rest of the form is still worth asking.
 */
function toTemplateField(
  raw: Schema.Schema.Type<typeof RawFormFieldSchema>,
  index: number,
): IssueTemplateField | null {
  const attributes = raw.attributes;
  const label = attributes?.label ?? "";
  const description = attributes?.description ?? "";
  const required = raw.validations?.required === true;
  // A form need not name a question. Where it does not, the place it is asked in files the answer —
  // a stand-in the caller moves aside if the form names it somewhere else.
  const id = trimmed(raw.id) ?? `field-${index}`;
  // Every kind but `markdown` is a heading in the filed body, so one with nothing to head is not a
  // question anybody could answer.
  if (raw.type !== "markdown" && trimmed(label) === null) return null;
  switch (raw.type) {
    case "markdown": {
      const value = attributes?.value ?? "";
      return value.length === 0 ? null : { kind: "markdown", value };
    }
    case "input":
      return {
        kind: "input",
        id,
        label,
        description,
        placeholder: attributes?.placeholder ?? "",
        value: attributes?.value ?? "",
        required,
      };
    case "textarea":
      return {
        kind: "textarea",
        id,
        label,
        description,
        placeholder: attributes?.placeholder ?? "",
        value: attributes?.value ?? "",
        render: trimmed(attributes?.render),
        required,
      };
    case "dropdown": {
      const options = toNameList(attributes?.options);
      return options.length === 0
        ? null
        : {
            kind: "dropdown",
            id,
            label,
            description,
            options,
            multiple: attributes?.multiple === true,
            required,
          };
    }
    case "checkboxes": {
      const options = (attributes?.options ?? []).flatMap((entry) => {
        const option = decodeCheckboxOption(entry);
        if (Exit.isFailure(option)) return [];
        const optionLabel = trimmed(option.value.label);
        return optionLabel === null
          ? []
          : [{ label: optionLabel, required: option.value.required === true }];
      });
      return options.length === 0 ? null : { kind: "checkboxes", id, label, description, options };
    }
    default:
      return null;
  }
}

/**
 * An id no other question of this form answers to.
 *
 * Answers are held by id, so two questions sharing one share an answer: the second control writes
 * over the first, and the issue is filed with one answer twice and the other not at all. A question
 * the form names keeps its name; only a stand-in — or the second of two questions the form named
 * the same thing — is moved out of the way, and it is moved past every name the form uses rather
 * than past the ones read so far, so a question further down still gets its own.
 */
function freeFieldId(
  candidate: string,
  named: ReadonlySet<string>,
  taken: ReadonlySet<string>,
): string {
  let id = candidate;
  let attempt = 2;
  while (named.has(id) || taken.has(id)) {
    id = `${candidate}-${attempt}`;
    attempt += 1;
  }
  return id;
}

/**
 * One `.github/ISSUE_TEMPLATE/*.yml` as the template it describes, or null for a file that is not a
 * form at all — a config, half-written YAML, something else that landed in the directory. Null
 * rather than a failure, because a repository's other templates and the blank issue filing falls
 * back to must survive one file nobody can read.
 */
export function decodeIssueFormYaml(filename: string, raw: string): IssueTemplate | null {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(raw);
  } catch {
    return null;
  }
  const form = decodeIssueForm(parsed);
  if (Exit.isFailure(form)) return null;
  const key = trimmed(filename);
  const name = trimmed(form.value.name);
  if (key === null || name === null) return null;
  const decoded = form.value.body.map((entry) => {
    const field = decodeFormField(entry);
    return Exit.isFailure(field) ? null : field.value;
  });
  // Every id the form names, read before any question is handed one, so a stand-in can be kept off
  // a name a question further down the form answers to.
  const named = new Set(
    decoded.flatMap((raw) => {
      const id = raw === null ? null : trimmed(raw.id);
      return id === null ? [] : [id];
    }),
  );
  const taken = new Set<string>();
  const fields = decoded.flatMap((raw, index): ReadonlyArray<IssueTemplateField> => {
    if (raw === null) return [];
    const mapped = toTemplateField(raw, index);
    if (mapped === null) return [];
    if (mapped.kind === "markdown") return [mapped];
    const own = trimmed(raw.id);
    const id = own !== null && !taken.has(own) ? own : freeFieldId(mapped.id, named, taken);
    taken.add(id);
    return [{ ...mapped, id }];
  });
  return {
    key,
    name,
    about: form.value.description ?? "",
    title: form.value.title ?? "",
    // A form has no draft to write over: its body is built from the answers instead.
    body: "",
    fields,
    labels: toNameList(form.value.labels).slice(0, TEMPLATE_LABELS),
    assignees: toNameList(form.value.assignees).slice(0, TEMPLATE_ASSIGNEES),
  };
}

/** `config.yml` is the chooser's own settings rather than one of the things it offers, and a
 *  markdown template is read through GitHub's own `issueTemplates` instead. */
function isFormFilename(name: string): boolean {
  const lowered = name.toLowerCase();
  if (lowered === "config.yml" || lowered === "config.yaml") return false;
  return lowered.endsWith(".yml") || lowered.endsWith(".yaml");
}

function contributingPath(repository: {
  readonly rootGuidelines?: unknown;
  readonly dotGitHubGuidelines?: unknown;
  readonly docsGuidelines?: unknown;
}): string | null {
  if (repository.rootGuidelines != null) return "CONTRIBUTING.md";
  if (repository.dotGitHubGuidelines != null) return ".github/CONTRIBUTING.md";
  if (repository.docsGuidelines != null) return "docs/CONTRIBUTING.md";
  return null;
}

export interface GitHubIssueForms {
  /** The forms as templates, keyed by filename the way GitHub's own template list keys them. */
  readonly forms: ReadonlyArray<IssueTemplate>;
  readonly contributingGuidelinesUrl: string | undefined;
}

/**
 * Every issue form the repository keeps, and where it wrote down how to contribute. A file that
 * cannot be read is skipped and the rest still arrive, the same way one malformed template does not
 * take the others with it.
 */
export function decodeIssueTemplateFormsJson(
  raw: string,
): Result.Result<GitHubIssueForms, DecodeFailure> {
  const decoded = decodeIssueTemplateForms(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const repository = decoded.success.data.repository;
  const forms: Array<IssueTemplate> = [];
  for (const entry of repository.forms?.entries ?? []) {
    const file = decodeTreeEntry(entry);
    if (Exit.isFailure(file)) continue;
    const text = file.value.object?.text;
    if (text == null || !isFormFilename(file.value.name)) continue;
    const form = decodeIssueFormYaml(file.value.name, text);
    if (form !== null) forms.push(form);
  }
  const repositoryUrl = trimmed(repository.url);
  const guidelines = contributingPath(repository);
  return Result.succeed({
    forms,
    contributingGuidelinesUrl:
      repositoryUrl === null || guidelines === null
        ? undefined
        : `${repositoryUrl}/blob/HEAD/${guidelines}`,
  });
}

/** What a repository that configured nothing offers, which is what GitHub itself defaults to. */
export const DEFAULT_ISSUE_TEMPLATE_CONFIG = {
  contactLinks: [],
  blankIssuesEnabled: true,
} satisfies Pick<IssueTemplateList, "contactLinks" | "blankIssuesEnabled">;

/**
 * `.github/ISSUE_TEMPLATE/config.yml`, which is hand-written and allowed to be absent. Neither an
 * unreadable file nor a missing one is a failure: both mean the repository configured nothing, and
 * refusing to open the composer over a stray tab in a YAML file would help nobody.
 */
export function decodeIssueTemplateConfigYaml(
  raw: string,
): Pick<IssueTemplateList, "contactLinks" | "blankIssuesEnabled"> {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(raw);
  } catch {
    return DEFAULT_ISSUE_TEMPLATE_CONFIG;
  }
  const config = decodeIssueTemplateConfig(parsed);
  if (Exit.isFailure(config)) return DEFAULT_ISSUE_TEMPLATE_CONFIG;
  const contactLinks: Array<IssueContactLink> = [];
  for (const entry of config.value.contact_links ?? []) {
    const link = decodeContactLinkEntry(entry);
    if (Exit.isFailure(link)) continue;
    const name = trimmed(link.value.name);
    const url = trimmed(link.value.url);
    if (name === null || url === null) continue;
    contactLinks.push({ name, url, about: link.value.about ?? "" });
  }
  // Only an explicit `false` takes the blank issue away; anything else, including a value that is
  // not a boolean at all, leaves it where GitHub puts it.
  return { contactLinks, blankIssuesEnabled: config.value.blank_issues_enabled !== false };
}
