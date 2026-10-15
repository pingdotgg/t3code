/**
 * GraphQL documents and decoders for GitHub issues. Enum-ish fields are decoded as plain strings
 * and normalized here, so a schema addition GitHub ships never fails a whole payload.
 *
 * @module source-control-github/server/gitHubIssueJson
 */
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  IssueActor,
  IssueComment,
  IssueEvent,
  IssueEventKind,
  IssueLabel,
  IssueLinkedPullRequest,
  IssueState,
  IssueTemplate,
  IssueViewerPermissions,
  PullRequestState,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";

import {
  REACTION_GROUPS_FIELDS,
  RawReactionGroupsSchema,
  toReactions,
} from "./gitHubPullRequestJson.ts";

/** GitHub's ceiling on a connection page, which is what every bounded read below asks for. */
const PAGE_SIZE = 100;
/** GitHub refuses a search page larger than this with EXCESSIVE_PAGINATION. */
export const SEARCH_MAX_ROWS = PAGE_SIZE;

const RawActorSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPageInfoSchema = Schema.Struct({
  hasNextPage: Schema.optional(Schema.Boolean),
  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
  hasPreviousPage: Schema.optional(Schema.Boolean),
  startCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const nodes = <S extends Schema.Top>(schema: S) =>
  Schema.optional(
    Schema.NullOr(
      Schema.Struct({ nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(schema)))) }),
    ),
  );

/** One issue row as both the search and the detail read answer with it. */
const RawIssueSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  /** The empty string on an open issue, so it is normalized rather than mapped. */
  stateReason: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  comments: Schema.optional(
    Schema.NullOr(Schema.Struct({ totalCount: Schema.optional(Schema.Int) })),
  ),
  assignees: nodes(RawActorSchema),
  labels: nodes(RawLabelSchema),
});

/** A row without its comment count, which the detail reads from its own comment page. */
const ISSUE_ROW_BASE_FIELDS = `number title url state stateReason createdAt updatedAt closedAt
  author { login avatarUrl ... on User { name } }
  assignees(first: 20) { nodes { login name avatarUrl } }
  labels(first: 20) { nodes { name color } }`;

const ISSUE_ROW_FIELDS = `${ISSUE_ROW_BASE_FIELDS}
  comments { totalCount }`;

/**
 * One repository's issues as a search, which is the only read that takes free text and an
 * updated-desc order with a cursor. `is:issue` keeps pull requests out of the shared index.
 */
export function issueSearchGraphQlQuery(rows: number): string {
  return `query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: ${Math.min(Math.max(Math.trunc(rows), 1), SEARCH_MAX_ROWS)}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { ${ISSUE_ROW_FIELDS} } }
  }
}`;
}

const RawSearchSchema = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      pageInfo: Schema.optional(Schema.NullOr(RawPageInfoSchema)),
      // Row by row, so a node that is not an issue is skipped rather than blanking the page.
      nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  }),
});

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

/** Every timeline union member as one flat shape; `__typename` decides which fields were meant. */
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
  source: Schema.optional(Schema.NullOr(RawReferenceSchema)),
  subject: Schema.optional(Schema.NullOr(RawReferenceSchema)),
});

const RawCommentSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  reactionGroups: RawReactionGroupsSchema,
});

const RawCommentsSchema = Schema.Struct({
  totalCount: Schema.optional(Schema.Int),
  pageInfo: Schema.optional(RawPageInfoSchema),
  nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawCommentSchema)))),
});

const RawViewerFieldsSchema = Schema.Struct({
  viewerCanUpdate: Schema.optional(Schema.Boolean),
});

const COMMENT_FIELDS = `id author { login avatarUrl } body createdAt url ${REACTION_GROUPS_FIELDS}`;

/**
 * The whole issue in one read: its row, body, the newest page of comments, the newest hundred
 * state changes, the change requests that close or mention it, and where the viewer stands.
 * Comments are read newest-last so the first page is the recent end; older pages follow
 * `pageInfo.startCursor` backwards.
 */
export const ISSUE_DETAIL_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    viewerPermission
    issue(number: $number) {
      ${ISSUE_ROW_BASE_FIELDS}
      body
      viewerCanUpdate
      ${REACTION_GROUPS_FIELDS}
      comments(last: ${PAGE_SIZE}) {
        totalCount
        pageInfo { hasPreviousPage startCursor }
        nodes { ${COMMENT_FIELDS} }
      }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
        nodes { number title url state isDraft repository { nameWithOwner } }
      }
      timelineItems(last: ${PAGE_SIZE}, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT]) {
        nodes {
          __typename
          ... on ClosedEvent { id createdAt actor { login avatarUrl } }
          ... on ReopenedEvent { id createdAt actor { login avatarUrl } }
          ... on LabeledEvent { id createdAt actor { login avatarUrl } label { name } }
          ... on UnlabeledEvent { id createdAt actor { login avatarUrl } label { name } }
          ... on AssignedEvent { id createdAt actor { login avatarUrl } assignee { ... on User { login name } ... on Bot { login } } }
          ... on UnassignedEvent { id createdAt actor { login avatarUrl } assignee { ... on User { login name } ... on Bot { login } } }
          ... on RenamedTitleEvent { id createdAt actor { login avatarUrl } currentTitle }
          ... on CrossReferencedEvent {
            id createdAt actor { login avatarUrl }
            source { __typename ... on PullRequest { number title url state isDraft repository { nameWithOwner } } ... on Issue { number repository { nameWithOwner } } }
          }
        }
      }
    }
  }
}`;

const RawDetailSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
    repository: Schema.Struct({
      viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
      /** Null for a number that names no issue the viewer can see. */
      issue: Schema.NullOr(
        Schema.Struct({
          ...RawIssueSchema.fields,
          ...RawViewerFieldsSchema.fields,
          body: Schema.optional(Schema.NullOr(Schema.String)),
          reactionGroups: RawReactionGroupsSchema,
          /** Overrides the row's count-only connection with the page the detail reads. */
          comments: Schema.optional(Schema.NullOr(RawCommentsSchema)),
          closedByPullRequestsReferences: nodes(RawReferenceSchema),
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

/** The rest of a long conversation, read backwards from a cursor the detail handed over. */
export const ISSUE_COMMENTS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: ${PAGE_SIZE}, before: $cursor) {
        pageInfo { hasPreviousPage startCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`;

const RawCommentPageSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
    repository: Schema.Struct({
      issue: Schema.NullOr(Schema.Struct({ comments: Schema.optional(RawCommentsSchema) })),
    }),
  }),
});

/**
 * The viewer's standing on its own, for deciding a write by what GitHub says now rather than by
 * what the page was told when it loaded.
 */
export const ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    issue(number: $number) { viewerCanUpdate }
  }
}`;

const RawViewerPermissionsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
      issue: Schema.NullOr(RawViewerFieldsSchema),
    }),
  }),
});

export const ISSUE_NODE_ID_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id } }
}`;

const RawIssueNodeIdSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({ issue: Schema.Struct({ id: Schema.String }) }),
  }),
});

/** Whether a comment id, which is global, hangs off the issue the request names. */
export const ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $commentId: ID!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id } }
  node(id: $commentId) { ... on IssueComment { issue { id } } }
}`;

const RawCommentScopeSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({ issue: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
    ),
    node: Schema.NullOr(
      Schema.Struct({ issue: Schema.optional(Schema.Struct({ id: Schema.String })) }),
    ),
  }),
});

/**
 * The labels a repository has and the people it may assign, in one read. `assignableUsers` is
 * the list GitHub's own picker is built from, where `collaborators` is refused to anyone without
 * push access.
 */
export const ISSUE_CANDIDATES_GRAPHQL_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    labels(first: ${PAGE_SIZE}) { pageInfo { hasNextPage } nodes { name color description } }
    assignableUsers(first: ${PAGE_SIZE}) { pageInfo { hasNextPage } nodes { login name avatarUrl } }
  }
}`;

const RawCandidatesSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      labels: Schema.Struct({
        pageInfo: Schema.optional(RawPageInfoSchema),
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawLabelSchema)))),
      }),
      assignableUsers: Schema.Struct({
        pageInfo: Schema.optional(RawPageInfoSchema),
        nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(RawActorSchema)))),
      }),
    }),
  }),
});

/**
 * The templates a repository offers, from the host rather than the checkout: a working tree sits
 * on whatever branch its reader left it on, and the templates are the default branch's.
 */
export const ISSUE_TEMPLATES_GRAPHQL_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issueTemplates {
      filename name about title body
      assignees(first: 25) { nodes { login } }
      labels(first: 50) { nodes { name } }
    }
  }
}`;

const RawTemplateSchema = Schema.Struct({
  filename: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  about: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  assignees: nodes(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
  labels: nodes(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
});

const RawTemplatesSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      issueTemplates: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  }),
});

const RawCreatedIssueSchema = Schema.Struct({ number: Schema.Int, html_url: Schema.String });

const decodeSearch = decodeJsonResult(RawSearchSchema);
const decodeIssueRow = Schema.decodeUnknownExit(RawIssueSchema);
const decodeDetail = decodeJsonResult(RawDetailSchema);
const decodeCommentPage = decodeJsonResult(RawCommentPageSchema);
const decodeViewerPermissions = decodeJsonResult(RawViewerPermissionsSchema);
const decodeNodeId = decodeJsonResult(RawIssueNodeIdSchema);
const decodeCommentScope = decodeJsonResult(RawCommentScopeSchema);
const decodeCandidates = decodeJsonResult(RawCandidatesSchema);
const decodeTemplates = decodeJsonResult(RawTemplatesSchema);
const decodeTemplate = Schema.decodeUnknownExit(RawTemplateSchema);
const decodeTimelineItem = Schema.decodeUnknownExit(RawTimelineItemSchema);
const decodeCreatedIssue = decodeJsonResult(RawCreatedIssueSchema);
const decodeViewerLogin = decodeJsonResult(
  Schema.Struct({ data: Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) }) }),
);

type DecodeFailure =
  ReturnType<typeof decodeSearch> extends Result.Result<unknown, infer E> ? E : never;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function toActor(raw: typeof RawActorSchema.Type | null | undefined): IssueActor | null {
  const login = trimmed(raw?.login);
  return login === null
    ? null
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatarUrl) };
}

function toActors(
  raw: ReadonlyArray<typeof RawActorSchema.Type | null> | null | undefined,
): ReadonlyArray<IssueActor> {
  return (raw ?? []).flatMap((entry) => toActor(entry) ?? []);
}

function toLabels(
  raw: ReadonlyArray<typeof RawLabelSchema.Type | null> | null | undefined,
): ReadonlyArray<IssueLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label?.name);
    return name === null ? [] : [{ name, color: trimmed(label?.color) }];
  });
}

/** GitHub spells a close reason `COMPLETED` / `NOT_PLANNED`; an open issue has `""` or `REOPENED`. */
function toIssueState(
  state: string | null | undefined,
  stateReason: string | null | undefined,
): IssueState {
  if (state?.trim().toUpperCase() !== "CLOSED") return { category: "open", name: "open" };
  const reason = stateReason?.trim().toUpperCase();
  return {
    category: "closed",
    name: "closed",
    ...(reason === "COMPLETED"
      ? { closeReason: "completed" }
      : reason === "NOT_PLANNED"
        ? { closeReason: "not-planned" }
        : {}),
  };
}

function toSummary(raw: typeof RawIssueSchema.Type): TrackerIssueSummary {
  return {
    key: String(raw.number),
    displayKey: `#${raw.number}`,
    title: raw.title,
    url: raw.url,
    author: toActor(raw.author),
    state: toIssueState(raw.state, raw.stateReason),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    closedAt: trimmed(raw.closedAt),
    assignees: toActors(raw.assignees?.nodes),
    labels: toLabels(raw.labels?.nodes),
    commentCount: Math.max(0, raw.comments?.totalCount ?? 0),
  };
}

export interface GitHubIssueSearchPage {
  readonly items: ReadonlyArray<TrackerIssueSummary>;
  readonly nextCursor: string | null;
}

export function decodeIssueSearchJson(
  raw: string,
): Result.Result<GitHubIssueSearchPage, DecodeFailure> {
  const decoded = decodeSearch(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const search = decoded.success.data.search;
  const items = (search.nodes ?? []).flatMap((entry) => {
    const row = decodeIssueRow(entry);
    return Exit.isSuccess(row) ? [toSummary(row.value)] : [];
  });
  return Result.succeed({
    items,
    nextCursor: search.pageInfo?.hasNextPage === true ? trimmed(search.pageInfo.endCursor) : null,
  });
}

function toPullRequestState(value: string | null | undefined): PullRequestState {
  switch (value?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return "open";
  }
}

function toLinkedPullRequest(
  raw: typeof RawReferenceSchema.Type | null | undefined,
  closesIssue: boolean,
): IssueLinkedPullRequest | null {
  if (raw == null) return null;
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
    state: toPullRequestState(raw.state),
    isDraft: raw.isDraft ?? false,
    closesIssue,
  };
}

/** The change GitHub recorded, or null for a kind this page has no vocabulary for. */
function toEventFields(
  raw: typeof RawTimelineItemSchema.Type,
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

function toComments(
  raw: typeof RawCommentsSchema.Type | null | undefined,
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
        reactions: toReactions(comment.reactionGroups, viewer),
      },
    ];
  });
}

/** Where a newest-last connection carries on into older rows; null once it is whole. */
function previousCursorOf(pageInfo: typeof RawPageInfoSchema.Type | undefined): string | null {
  return pageInfo?.hasPreviousPage === true ? trimmed(pageInfo.startCursor) : null;
}

/**
 * What the signed-in account may do. Closing and editing go by `viewerCanUpdate`, which GitHub
 * grants the author as well as anyone with write; labelling and assigning need the triage role
 * or better. Commenting is not gated: seeing the repository is enough to say something in it.
 * An install that reports nothing grants rather than withholds, so the host's own refusal says why.
 */
function toViewerPermissions(raw: {
  readonly viewerPermission?: string | null | undefined;
  readonly issue: typeof RawViewerFieldsSchema.Type | null;
}): IssueViewerPermissions {
  const canUpdate = raw.issue?.viewerCanUpdate !== false;
  const canTriage = ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"].includes(
    raw.viewerPermission?.trim().toUpperCase() ?? "",
  );
  return {
    setState: canUpdate,
    comment: true,
    edit: canUpdate,
    labels: canTriage,
    assignees: canTriage,
  };
}

export interface GitHubIssueDetail extends TrackerIssueSummary {
  readonly body: string;
  readonly viewer: string | null;
  readonly viewerPermissions: IssueViewerPermissions;
  readonly reactions: ReturnType<typeof toReactions>;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly commentsCursor: string | null;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly linkedPullRequests: ReadonlyArray<IssueLinkedPullRequest>;
}

/** Null for a number that names no issue the viewer can see. */
export function decodeIssueDetailJson(
  raw: string,
): Result.Result<GitHubIssueDetail | null, DecodeFailure> {
  const decoded = decodeDetail(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const { viewer: rawViewer, repository } = decoded.success.data;
  const issue = repository.issue;
  if (issue === null) return Result.succeed(null);
  const viewer = trimmed(rawViewer?.login);

  // Closing references lead; a cross-reference seen twice is filed under the stronger relation.
  const links = new Map<string, IssueLinkedPullRequest>();
  for (const node of issue.closedByPullRequestsReferences?.nodes ?? []) {
    const link = toLinkedPullRequest(node, true);
    if (link !== null) links.set(`${link.repository.toLowerCase()}#${link.number}`, link);
  }
  const events: IssueEvent[] = [];
  for (const entry of issue.timelineItems?.nodes ?? []) {
    const item = decodeTimelineItem(entry);
    if (!Exit.isSuccess(item)) continue;
    if (item.value.__typename === "CrossReferencedEvent") {
      const link = toLinkedPullRequest(item.value.source, false);
      const linkKey = link === null ? null : `${link.repository.toLowerCase()}#${link.number}`;
      if (link !== null && linkKey !== null && !links.has(linkKey)) links.set(linkKey, link);
    }
    const fields = toEventFields(item.value);
    const id = trimmed(item.value.id);
    const createdAt = trimmed(item.value.createdAt);
    if (fields === null || id === null || createdAt === null) continue;
    events.push({ id, ...fields, actor: toActor(item.value.actor), createdAt });
  }
  return Result.succeed({
    ...toSummary(issue),
    body: issue.body ?? "",
    viewer,
    viewerPermissions: toViewerPermissions({
      viewerPermission: repository.viewerPermission,
      issue,
    }),
    reactions: toReactions(issue.reactionGroups, viewer),
    comments: toComments(issue.comments, viewer),
    commentsCursor: previousCursorOf(issue.comments?.pageInfo),
    events,
    linkedPullRequests: [...links.values()],
  });
}

export function decodeIssueCommentsJson(
  raw: string,
): Result.Result<
  { readonly comments: ReadonlyArray<IssueComment>; readonly nextCursor: string | null },
  DecodeFailure
> {
  const decoded = decodeCommentPage(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const comments = decoded.success.data.repository.issue?.comments;
  const viewer = trimmed(decoded.success.data.viewer?.login);
  return Result.succeed({
    comments: toComments(comments, viewer),
    nextCursor: previousCursorOf(comments?.pageInfo),
  });
}

export function decodeIssueViewerPermissionsJson(
  raw: string,
): Result.Result<IssueViewerPermissions, DecodeFailure> {
  return Result.map(decodeViewerPermissions(raw), ({ data }) =>
    toViewerPermissions(data.repository),
  );
}

export function decodeIssueNodeIdJson(raw: string): Result.Result<string, DecodeFailure> {
  return Result.map(decodeNodeId(raw), ({ data }) => data.repository.issue.id);
}

export function decodeIssueCommentScopeJson(raw: string): Result.Result<boolean, DecodeFailure> {
  return Result.map(decodeCommentScope(raw), ({ data }) => {
    const expected = data.repository?.issue?.id ?? null;
    return expected !== null && expected === (data.node?.issue?.id ?? null);
  });
}

export function decodeViewerLoginJson(raw: string): Result.Result<string, DecodeFailure> {
  return Result.map(decodeViewerLogin(raw), ({ data }) => data.viewer.login);
}

export function decodeIssueCandidatesJson(raw: string): Result.Result<
  {
    readonly labels: ReadonlyArray<IssueLabel & { readonly description: string | null }>;
    readonly assignees: ReadonlyArray<IssueActor & { readonly id: string }>;
    readonly truncated: boolean;
  },
  DecodeFailure
> {
  return Result.map(decodeCandidates(raw), ({ data }) => {
    const { labels, assignableUsers } = data.repository;
    return {
      labels: (labels.nodes ?? []).flatMap((label) => {
        const name = trimmed(label?.name);
        return name === null
          ? []
          : [{ name, color: trimmed(label?.color), description: trimmed(label?.description) }];
      }),
      // GitHub addresses an assignee by the login it shows, so the id is the handle itself.
      assignees: toActors(assignableUsers.nodes).map((actor) => ({ ...actor, id: actor.login })),
      truncated:
        labels.pageInfo?.hasNextPage === true || assignableUsers.pageInfo?.hasNextPage === true,
    };
  });
}

/** A template that cannot be read is skipped: one malformed form must not take the others. */
export function decodeIssueTemplatesJson(
  raw: string,
): Result.Result<ReadonlyArray<IssueTemplate>, DecodeFailure> {
  return Result.map(decodeTemplates(raw), ({ data }) =>
    (data.repository.issueTemplates ?? []).flatMap((entry) => {
      const template = decodeTemplate(entry);
      if (Exit.isFailure(template)) return [];
      const key = trimmed(template.value.filename);
      if (key === null) return [];
      return [
        {
          key,
          name: trimmed(template.value.name) ?? key,
          about: template.value.about ?? "",
          title: template.value.title ?? "",
          body: template.value.body ?? "",
          labels: (template.value.labels?.nodes ?? []).flatMap((node) => trimmed(node?.name) ?? []),
          assignees: (template.value.assignees?.nodes ?? []).flatMap(
            (node) => trimmed(node?.login) ?? [],
          ),
        },
      ];
    }),
  );
}

export function decodeCreatedIssueJson(
  raw: string,
): Result.Result<{ readonly number: number; readonly url: string }, DecodeFailure> {
  return Result.map(decodeCreatedIssue(raw), (issue) => ({
    number: issue.number,
    url: issue.html_url,
  }));
}
