import type {
  IssueDetail,
  IssueLink,
  IssueListSort,
  IssueListState,
  IssuePullRequest,
  IssueReviewStatus,
  IssueState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  qualifierValue,
  searchPhrase,
  SEARCH_REPOSITORY,
} from "../pullRequest/GitHubPullRequestCli.ts";

/** GitHub's ceiling on a search page. */
export const ISSUE_SEARCH_MAX_ROWS = 100;
/** Children read per Issue; `subIssueCount` says when there are more. */
const SUB_ISSUE_PAGE = 50;
/** Newest comments the side panel shows. */
const COMMENT_PAGE = 100;
/** Closing pull requests read per Issue; more than a few is rare. */
const CLOSING_PULL_REQUEST_PAGE = 10;
/** Thread-linked pull requests read with one search's first page. */
export const LINKED_PULL_REQUEST_MAX = 50;
/** The commit status AgentsMD's independent review posts on a pull request's head. */
export const REVIEW_MARK_CONTEXT = "review/independent";

/**
 * The Issues search, built the way the pull request search is (`searchQuery` in
 * GitHubPullRequestCli): typed text is one quoted phrase and label and milestone values are
 * quoted, so nothing a reader types can widen the search. Null when a repository is not a plain
 * `owner/name`.
 */
export function issueSearchQuery(input: {
  readonly repositories: ReadonlyArray<string>;
  readonly state: IssueListState;
  readonly sort?: IssueListSort | undefined;
  readonly query?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly milestone?: string | undefined;
}): string | null {
  if (input.repositories.length === 0) return null;
  const repositories = input.repositories.map((repository) => repository.trim());
  if (!repositories.every((repository) => SEARCH_REPOSITORY.test(repository))) return null;
  const query = input.query?.trim() ?? "";
  return [
    "is:issue",
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed"] : []),
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    ...(input.labels ?? []).map((label) => `label:${qualifierValue(label)}`),
    ...(input.milestone === undefined ? [] : [`milestone:${qualifierValue(input.milestone)}`]),
    // Number order is creation order on GitHub; the page sorts the rows it holds exactly.
    input.sort === "created" || input.sort === "number" ? "sort:created-desc" : "sort:updated-desc",
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(" ");
}

const LINK_FIELDS = "number title url state stateReason repository { nameWithOwner }";

/** A commit's review mark and who posted it; trust is decided against the query's viewer. */
export const COMMIT_REVIEW_FIELDS = `oid status { context(name: "${REVIEW_MARK_CONTEXT}") { state creator { login } } }`;

const PULL_REQUEST_FIELDS = `number url state isDraft headRefName headRefOid repository { nameWithOwner }
            headRef { target { ... on Commit { ${COMMIT_REVIEW_FIELDS} } } }`;

/** The alias a thread-linked pull request is read under, by its position in the request. */
const linkedAlias = (index: number) => `linked${index}`;

function linkedAliases(
  linkedPullRequests: ReadonlyArray<{ readonly repository: string; readonly number: number }>,
  host: string,
): string {
  return linkedPullRequests
    .slice(0, LINKED_PULL_REQUEST_MAX)
    .flatMap(({ repository, number }, index) => {
      if (
        !/^[a-z0-9.-]+(?::\d+)?$/iu.test(host) ||
        !SEARCH_REPOSITORY.test(repository) ||
        !Number.isSafeInteger(number) ||
        number < 1
      ) {
        return [];
      }
      const url = `https://${host}/${repository}/pull/${number}`;
      return [
        `  ${linkedAlias(index)}: resource(url: "${url}") { ... on PullRequest { ${PULL_REQUEST_FIELDS} } }`,
      ];
    })
    .join("\n");
}

/**
 * Only the thread-linked pull requests and the viewer, for a server whose repositories this list
 * does not search (a repository filter names none of them).
 */
export function linkedPullRequestsGraphQlQuery(
  linkedPullRequests: ReadonlyArray<{ readonly repository: string; readonly number: number }>,
  host: string,
): string {
  return `query {
${linkedAliases(linkedPullRequests, host)}
  viewer { login }
}`;
}

export const decodeViewerJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({ data: Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) }) }),
  ),
);

/**
 * The search page, plus each given pull request on `host` as its own alias in the same request.
 * Aliases go through `resource(url:)`, which answers null for a pull request that no longer exists
 * where `repository.pullRequest` would fail the whole request. Host, owner, name and number are
 * validated before they are written into the document.
 */
export function issueSearchGraphQlQuery(
  rows: number,
  linkedPullRequests: ReadonlyArray<{ readonly repository: string; readonly number: number }> = [],
  host = "github.com",
): string {
  const first = Math.min(Math.max(Math.trunc(rows), 1), ISSUE_SEARCH_MAX_ROWS);
  const linked = linkedAliases(linkedPullRequests, host);
  return `query($q: String!, $after: String) {
${linked}
  viewer { login }
  search(query: $q, type: ISSUE, first: ${first}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        ${LINK_FIELDS}
        createdAt
        updatedAt
        author { login }
        labels(first: 20) { nodes { name color } }
        milestone { title }
        comments { totalCount }
        parent { ${LINK_FIELDS} }
        subIssues(first: ${SUB_ISSUE_PAGE}) { totalCount nodes { ${LINK_FIELDS} } }
        issueDependenciesSummary { blockedBy }
        closedByPullRequestsReferences(first: ${CLOSING_PULL_REQUEST_PAGE}, includeClosedPrs: true) {
          nodes { ${PULL_REQUEST_FIELDS} }
        }
      }
    }
  }
}`;
}

/** The number is a validated positive integer written into the document; the rest are variables. */
export function issueDetailGraphQlQuery(number: number): string {
  return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: ${Math.trunc(number)}) {
      ${LINK_FIELDS}
      body
      createdAt
      updatedAt
      locked
      viewerCanClose
      viewerCanReopen
      author { login }
      closedByPullRequestsReferences(first: ${CLOSING_PULL_REQUEST_PAGE}, includeClosedPrs: true) {
        nodes { ${PULL_REQUEST_FIELDS} }
      }
      comments(last: ${COMMENT_PAGE}) {
        totalCount
        nodes { id url body createdAt author { login } }
      }
    }
  }
}`;
}

const Actor = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const LinkNode = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  stateReason: Schema.NullOr(Schema.String),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});
type LinkNode = typeof LinkNode.Type;

// A non-commit target answers `{}`, which this reads as no mark.
const ReviewCommit = Schema.Struct({
  oid: Schema.optional(Schema.String),
  status: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        context: Schema.NullOr(Schema.Struct({ state: Schema.String, creator: Actor })),
      }),
    ),
  ),
});
export type GitHubReviewCommit = typeof ReviewCommit.Type;

const ClosingPullRequestNode = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
  // Null once the branch is deleted; the pull request is then closed or merged anyway.
  headRef: Schema.NullOr(Schema.Struct({ target: Schema.NullOr(ReviewCommit) })),
});
type ClosingPullRequestNode = typeof ClosingPullRequestNode.Type;

const SearchNode = Schema.Struct({
  ...LinkNode.fields,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  author: Actor,
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
  }),
  milestone: Schema.NullOr(Schema.Struct({ title: Schema.String })),
  comments: Schema.Struct({ totalCount: Schema.Number }),
  parent: Schema.NullOr(LinkNode),
  subIssues: Schema.Struct({ totalCount: Schema.Number, nodes: Schema.Array(LinkNode) }),
  issueDependenciesSummary: Schema.Struct({ blockedBy: Schema.Number }),
  closedByPullRequestsReferences: Schema.Struct({
    nodes: Schema.Array(Schema.NullOr(ClosingPullRequestNode)),
  }),
});
export type GitHubIssueSearchNode = typeof SearchNode.Type;

const IssueSearchJson = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    search: Schema.Struct({
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
      // `is:issue` keeps pull requests out, so every node is an Issue.
      nodes: Schema.Array(SearchNode),
    }),
  }),
});
export type GitHubIssueSearchJson = typeof IssueSearchJson.Type;

export const decodeIssueSearchJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(IssueSearchJson),
);

const decodeAnswerFields = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })),
);
// A resource that is not a pull request answers `{}` and fails to decode, like a missing one.
const decodeLinkedAlias = Schema.decodeUnknownOption(ClosingPullRequestNode);

/** The thread-linked pull requests a search answer carries; missing or unreadable ones drop. */
export function linkedPullRequestsOf(host: string, raw: string): ReadonlyArray<IssuePullRequest> {
  const answer = decodeAnswerFields(raw);
  if (answer._tag === "None") return [];
  return Object.entries(answer.value.data).flatMap(([alias, value]) => {
    if (!alias.startsWith("linked")) return [];
    const linked = decodeLinkedAlias(value);
    return linked._tag === "Some" ? [pullRequestOf(host, linked.value)] : [];
  });
}

const DetailNode = Schema.Struct({
  ...LinkNode.fields,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  locked: Schema.Boolean,
  viewerCanClose: Schema.Boolean,
  viewerCanReopen: Schema.Boolean,
  author: Actor,
  closedByPullRequestsReferences: Schema.Struct({
    nodes: Schema.Array(Schema.NullOr(ClosingPullRequestNode)),
  }),
  comments: Schema.Struct({
    totalCount: Schema.Number,
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        url: Schema.String,
        body: Schema.String,
        createdAt: Schema.String,
        author: Actor,
      }),
    ),
  }),
});
export type GitHubIssueDetailNode = typeof DetailNode.Type;

export const decodeIssueDetailJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(Schema.Struct({ issue: Schema.NullOr(DetailNode) })),
      }),
    }),
  ),
);

export function issueStateOf(node: Pick<LinkNode, "state" | "stateReason">): IssueState {
  if (node.state === "OPEN") return "open";
  return node.stateReason === "NOT_PLANNED" || node.stateReason === "DUPLICATE"
    ? "not-planned"
    : "done";
}

export function issueLinkOf(host: string, node: LinkNode): IssueLink {
  return {
    host,
    repository: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    state: issueStateOf(node),
  };
}

/**
 * The head commit's `review/independent` status and who posted it; clients decide trust. GitHub
 * keeps only the newest status per context, so an untrusted status posted after a trusted one
 * hides it until the trusted account posts again.
 */
export function reviewStatusOf(
  commit: GitHubReviewCommit | null | undefined,
): IssueReviewStatus | null {
  const context = commit?.status?.context ?? null;
  if (context === null) return null;
  const creator = context.creator?.login || null;
  switch (context.state) {
    case "SUCCESS":
      return { state: "success", creator };
    case "FAILURE":
    case "ERROR":
      return { state: "failure", creator };
    case "PENDING":
    case "EXPECTED":
      return { state: "pending", creator };
    default:
      return null;
  }
}

export function pullRequestOf(host: string, node: ClosingPullRequestNode): IssuePullRequest {
  // The branch can have moved past the head GitHub last synced; only the head's own mark counts.
  const target = node.headRef?.target ?? null;
  const head = target?.oid === node.headRefOid ? target : null;
  return {
    host,
    repository: node.repository.nameWithOwner,
    number: node.number,
    url: node.url,
    state: node.state === "MERGED" ? "merged" : node.state === "OPEN" ? "open" : "closed",
    isDraft: node.isDraft,
    headRefName: node.headRefName,
    headSha: node.headRefOid || null,
    review: reviewStatusOf(head),
  };
}

/** The side panel's Issue, closing pull requests included; null nodes (no access) drop. */
export function issueDetailOf(host: string, issue: GitHubIssueDetailNode): IssueDetail {
  return {
    ...issueLinkOf(host, issue),
    author: issue.author?.login || null,
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    comments: issue.comments.nodes.map((comment) => ({
      id: comment.id,
      author: comment.author?.login || null,
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
    })),
    commentCount: issue.comments.totalCount,
    locked: issue.locked,
    viewerCanClose: issue.viewerCanClose,
    viewerCanReopen: issue.viewerCanReopen,
    closingPullRequests: issue.closedByPullRequestsReferences.nodes.flatMap((pullRequest) =>
      pullRequest === null ? [] : [pullRequestOf(host, pullRequest)],
    ),
  };
}
