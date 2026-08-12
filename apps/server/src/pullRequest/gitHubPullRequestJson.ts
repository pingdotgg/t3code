import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestComment,
  PullRequestCommit,
  PullRequestLabel,
  PullRequestMergeCapabilities,
  PullRequestOmittedFileStat,
  PullRequestMergeability,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewDecision,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidate,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestState,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { dedupeChecks } from "./pullRequestChecks.ts";

/**
 * Enum-ish GitHub CLI fields are decoded as plain strings and normalized here: a `gh`
 * release that adds a conclusion or a review state must not fail the whole payload.
 */
const RawActorSchema = Schema.Struct({
  /**
   * Optional because a review can be requested from a team or a mannequin, which the query has
   * no fragment for and GraphQL answers with an empty object. A reviewer with no login names
   * nobody to show, and must not fail the response the conversation travels in.
   */
  login: Schema.optional(Schema.String),
  /** The node id, which is how a listing's authors are resolved to avatars in one request. */
  id: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  /** Only the GraphQL API reports one; `gh pr view --json` has no avatar to give. */
  avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewRequestSchema = Schema.Struct({
  login: Schema.optional(Schema.NullOr(Schema.String)),
  slug: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCheckSchema = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * What tells two same-named checks apart, and which run of one is the newest. All three ride
   * along with `statusCheckRollup` already — it is asked for as a whole field — so reading them
   * costs no request. Empty for an app-provided check run, which belongs to no workflow, and
   * absent entirely on a commit status, which is not a run at all.
   */
  workflowName: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawListItemSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  headRefName: Schema.String,
  baseRefName: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.Int),
  deletions: Schema.optional(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  reviewRequests: Schema.optional(Schema.Array(RawReviewRequestSchema)),
  labels: Schema.optional(Schema.Array(RawLabelSchema)),
  /**
   * Every check of the head commit, which is the only rollup `gh pr list --json` can give: there
   * is no field for the one-word verdict. Measured against `pingdotgg/t3code`, asking for it costs
   * 0.6s -> 7.9s at a hundred rows and 0.9s -> 2.1s at thirty, for 425 KB of checks a listing
   * reduces to one word. The listing pays it because the alternative is a request per row; the
   * cross-repository search below asks GitHub for the verdict itself instead.
   */
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(RawCheckSchema))),
});

/**
 * A search's own answer, which is the listing's row one connection deeper: `gh pr list --json`
 * flattens reviewers and labels, and GraphQL does not. Everything below the row is optional
 * because a node that is not a pull request decodes as an empty object, which is skipped.
 */
const RawSearchItemSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  headRefName: Schema.String,
  baseRefName: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  isDraft: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  reviewDecision: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  repository: Schema.optional(Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String }))),
  reviewRequests: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.NullOr(
                Schema.Struct({
                  requestedReviewer: Schema.optional(Schema.NullOr(RawActorSchema)),
                }),
              ),
            ),
          ),
        ),
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
  /**
   * GraphQL answers the rollup a listing actually wants — one enum for the head commit, rather
   * than the whole check array `gh pr list --json` insists on. Measured at a hundred rows across
   * this repository: 0.8s -> 3.0s and 15 KB, against 425 KB for the same verdict over `gh`.
   */
  commits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.NullOr(
                Schema.Struct({
                  commit: Schema.optional(
                    Schema.NullOr(
                      Schema.Struct({
                        statusCheckRollup: Schema.optional(
                          Schema.NullOr(Schema.Struct({ state: Schema.String })),
                        ),
                      }),
                    ),
                  ),
                }),
              ),
            ),
          ),
        ),
      }),
    ),
  ),
});

const RawSearchSchema = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      pageInfo: Schema.optional(Schema.NullOr(Schema.Struct({ hasNextPage: Schema.Boolean }))),
      // Row by row, like the listing's own: a node that is not a pull request — or one field
      // GitHub changes — is skipped rather than blanking every repository at once.
      nodes: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  }),
});

/** One aliased lookup per row, so the response is keyed by the position it was asked in. */
const RawStatsSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  additions: Schema.optional(Schema.NullOr(Schema.Int)),
                  deletions: Schema.optional(Schema.NullOr(Schema.Int)),
                }),
              ),
            ),
          }),
        ),
      ),
    ),
  ),
});

/** How many of a reaction's people the hover names before it counts the rest. */
const REACTORS_PER_GROUP = 10;

/**
 * A reaction group as every reactable node reports it. `reactors` is bounded rather than paged:
 * a hover says who reacted, and a hundred and forty names is a count, not a sentence.
 */
const REACTION_GROUPS_FIELDS = `reactionGroups {
  content
  viewerHasReacted
  reactors(first: ${REACTORS_PER_GROUP}) {
    totalCount
    nodes {
      ... on User { login }
      ... on Bot { login }
      ... on Organization { login }
      ... on Mannequin { login }
    }
  }
}`;

/** GitHub's reaction names, which are the same eight the contract carries under other spellings. */
const REACTION_CONTENT_BY_GITHUB: Readonly<Record<string, PullRequestReactionContent>> = {
  THUMBS_UP: "thumbs-up",
  THUMBS_DOWN: "thumbs-down",
  LAUGH: "laugh",
  HOORAY: "hooray",
  CONFUSED: "confused",
  HEART: "heart",
  ROCKET: "rocket",
  EYES: "eyes",
};

const GITHUB_REACTION_BY_CONTENT: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "THUMBS_UP",
  "thumbs-down": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
};

export function gitHubReactionContent(content: PullRequestReactionContent): string {
  return GITHUB_REACTION_BY_CONTENT[content];
}

const RawReactionGroupsSchema = Schema.optional(
  Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        viewerHasReacted: Schema.optional(Schema.Boolean),
        reactors: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              totalCount: Schema.optional(Schema.Int),
              nodes: Schema.optional(
                Schema.NullOr(
                  Schema.Array(
                    Schema.NullOr(
                      Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) }),
                    ),
                  ),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
);

type RawReactionGroups = typeof RawReactionGroupsSchema.Type;

/**
 * The groups GitHub answered with, as the contract carries them. A group with nobody behind it is
 * dropped: GitHub answers with a group per content it knows, including the ones nobody chose. The
 * viewer's own login is left out of `actors` — the page names them "You" instead, and leaving it
 * in would name them twice — but `count` still counts them along with everyone else.
 */
function toReactions(
  groups: RawReactionGroups,
  viewer: string | null,
): ReadonlyArray<PullRequestReaction> {
  const normalizedViewer = viewer?.toLowerCase() ?? null;
  const reactions: PullRequestReaction[] = [];
  for (const group of groups ?? []) {
    const content = REACTION_CONTENT_BY_GITHUB[trimmed(group.content)?.toUpperCase() ?? ""];
    if (content === undefined) continue;
    const logins = (group.reactors?.nodes ?? []).flatMap((node) => trimmed(node?.login) ?? []);
    const count = Math.max(group.reactors?.totalCount ?? logins.length, logins.length);
    if (count <= 0) continue;
    const actors =
      normalizedViewer === null
        ? logins
        : logins.filter((login) => login.toLowerCase() !== normalizedViewer);
    reactions.push({ content, count, actors, viewerHasReacted: group.viewerHasReacted === true });
  }
  return reactions;
}

const RawCommentSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  body: Schema.optional(Schema.String),
  createdAt: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  /** Only ever present on a GraphQL read; `gh pr view --json` reports no reaction at all. */
  reactionGroups: RawReactionGroupsSchema,
});

const RawReviewSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  body: Schema.optional(Schema.String),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCommitSchema = Schema.Struct({
  oid: Schema.String,
  messageHeadline: Schema.optional(Schema.String),
  committedDate: Schema.String,
  authors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        email: Schema.optional(Schema.NullOr(Schema.String)),
        id: Schema.optional(Schema.NullOr(Schema.String)),
        login: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const RawDetailSchema = Schema.Struct({
  ...RawListItemSchema.fields,
  /** Names the fork a pull request came from, which is what qualifies its head ref. */
  headRepositoryOwner: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  body: Schema.optional(Schema.String),
  changedFiles: Schema.optional(Schema.Int),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * The standing instruction to merge once GitHub's own requirements are met, which is an object
   * describing who armed it and how, and a JSON null where nobody has. Nothing inside it is read:
   * the question the page asks is whether one exists.
   */
  autoMergeRequest: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

const RawActivitySchema = Schema.Struct({
  author: Schema.optional(Schema.NullOr(RawActorSchema)),
  comments: Schema.optional(Schema.Array(RawCommentSchema)),
  reviews: Schema.optional(Schema.Array(RawReviewSchema)),
  commits: Schema.optional(Schema.Array(RawCommitSchema)),
});

/** Where a connection carries on from, which is what every paged read below follows. */
const RawPageInfoSchema = Schema.Struct({
  hasNextPage: Schema.optional(Schema.Boolean),
  endCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * What GitHub says the viewer may do with a pull request. Both are optional so that an install
 * that answers without them still delivers the conversation they travel with; an absent field
 * reads as granted, which is what an unknown permission is.
 */
const RawViewerFieldsSchema = Schema.Struct({
  viewerCanUpdate: Schema.optional(Schema.Boolean),
  viewerDidAuthor: Schema.optional(Schema.Boolean),
});

const RawThreadCommentsSchema = Schema.Struct({
  totalCount: Schema.optional(Schema.Int),
  pageInfo: Schema.optional(RawPageInfoSchema),
  nodes: Schema.Array(RawCommentSchema),
});

/** `gh pr view --json` cannot reach review threads, so they come from the GraphQL API. */
const RawReviewThreadsSchema = Schema.Struct({
  data: Schema.Struct({
    // Rides along in the same request: GitHub names who reacted but never says whether that is
    // the reader, so the comparison is made here rather than paid for with a request of its own.
    viewer: Schema.optional(
      Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        reviewThreads: Schema.Struct({
          totalCount: Schema.optional(Schema.Int),
          pageInfo: Schema.optional(RawPageInfoSchema),
          nodes: Schema.Array(
            Schema.Struct({
              id: Schema.optional(Schema.NullOr(Schema.String)),
              isResolved: Schema.optional(Schema.Boolean),
              isOutdated: Schema.optional(Schema.Boolean),
              path: Schema.optional(Schema.NullOr(Schema.String)),
              /** Null once the thread's line has left the diff, which `isOutdated` reports. */
              line: Schema.optional(Schema.NullOr(Schema.Int)),
              diffSide: Schema.optional(Schema.NullOr(Schema.String)),
              comments: RawThreadCommentsSchema,
            }),
          ),
        }),
        ...RawViewerFieldsSchema.fields,
        author: Schema.optional(Schema.NullOr(RawActorSchema)),
        reactionGroups: RawReactionGroupsSchema,
        comments: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  id: Schema.optional(Schema.NullOr(Schema.String)),
                  author: Schema.optional(Schema.NullOr(RawActorSchema)),
                  reactionGroups: RawReactionGroupsSchema,
                }),
              ),
            }),
          ),
        ),
        /**
         * Reviews for their reactions alone: the words and the verdict arrive with
         * `gh pr view --json reviews`, which reports no reaction of any kind.
         */
        reviews: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  id: Schema.optional(Schema.NullOr(Schema.String)),
                  reactionGroups: RawReactionGroupsSchema,
                }),
              ),
            }),
          ),
        ),
        reviewRequests: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  // Null for a team, which is a request nobody in particular owns.
                  requestedReviewer: Schema.optional(Schema.NullOr(RawActorSchema)),
                }),
              ),
            }),
          ),
        ),
        latestReviews: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({ author: Schema.optional(Schema.NullOr(RawActorSchema)) }),
              ),
            }),
          ),
        ),
        reviewDismissals: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              pageInfo: Schema.optional(RawPageInfoSchema),
              nodes: Schema.Array(
                Schema.Struct({
                  dismissalMessage: Schema.optional(Schema.NullOr(Schema.String)),
                  review: Schema.optional(
                    Schema.NullOr(
                      Schema.Struct({ id: Schema.optional(Schema.NullOr(Schema.String)) }),
                    ),
                  ),
                }),
              ),
            }),
          ),
        ),
        commits: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  commit: Schema.Struct({
                    oid: Schema.String,
                    messageHeadline: Schema.optional(Schema.NullOr(Schema.String)),
                    committedDate: Schema.optional(Schema.NullOr(Schema.String)),
                    additions: Schema.optional(Schema.Int),
                    deletions: Schema.optional(Schema.Int),
                    authors: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          nodes: Schema.Array(
                            Schema.Struct({
                              name: Schema.optional(Schema.NullOr(Schema.String)),
                              avatarUrl: Schema.optional(Schema.NullOr(Schema.String)),
                              user: Schema.optional(
                                Schema.NullOr(
                                  Schema.Struct({
                                    login: Schema.optional(Schema.NullOr(Schema.String)),
                                  }),
                                ),
                              ),
                            }),
                          ),
                        }),
                      ),
                    ),
                  }),
                }),
              ),
            }),
          ),
        ),
      }),
    }),
  }),
});

/** Requested together, so a response missing any of them fails rather than defaulting open:
 *  guessing `true` would offer a merge method the repository forbids. */
const RawRepositoryAccessSchema = Schema.Struct({
  mergeCommitAllowed: Schema.Boolean,
  squashMergeAllowed: Schema.Boolean,
  rebaseMergeAllowed: Schema.Boolean,
  /**
   * ADMIN, MAINTAIN, WRITE, TRIAGE, READ or NONE. Optional rather than required, unlike the
   * three above: an install that does not report it leaves the viewer's standing unknown, which
   * is answered by granting rather than by failing the whole detail read.
   */
  viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawPullRequestFileSchema = Schema.Struct({
  filename: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  /** Only on a rename, where it names the file the hunks are counted against. */
  previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
  /** Absent for a binary file, and for one whose diff GitHub considers too large. */
  patch: Schema.optional(Schema.NullOr(Schema.String)),
  /** Whether anything was withheld is the difference between a binary file and a pure rename. */
  additions: Schema.optional(Schema.NullOr(Schema.Int)),
  deletions: Schema.optional(Schema.NullOr(Schema.Int)),
});

/** Resolves a listing's authors to avatars, which no `gh` JSON field carries. */
export const ACTOR_AVATARS_GRAPHQL_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on User { login avatarUrl }
    ... on Bot { login avatarUrl }
  }
}`;

const RawActorAvatarsSchema = Schema.Struct({
  data: Schema.Struct({
    nodes: Schema.Array(Schema.NullOr(RawActorSchema)),
  }),
});

const decodeActorAvatars = decodeJsonResult(RawActorAvatarsSchema);

export function decodeActorAvatarsJson(
  raw: string,
): Result.Result<ReadonlyMap<string, string>, DecodeFailure> {
  const decoded = decodeActorAvatars(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const avatarsByLogin = new Map<string, string>();
  for (const node of decoded.success.data.nodes) {
    const login = trimmed(node?.login);
    const avatarUrl = trimmed(node?.avatarUrl);
    if (login !== null && avatarUrl !== null) avatarsByLogin.set(login, avatarUrl);
  }
  return Result.succeed(avatarsByLogin);
}

export const PULL_REQUEST_LIST_JSON_FIELDS =
  "number,title,url,author,headRefName,baseRefName,state,isDraft,mergeable,reviewDecision,additions,deletions,createdAt,updatedAt,mergedAt,reviewRequests,labels,statusCheckRollup";

export const PULL_REQUEST_DETAIL_JSON_FIELDS = `${PULL_REQUEST_LIST_JSON_FIELDS},body,changedFiles,closedAt,headRepositoryOwner,autoMergeRequest`;
export const PULL_REQUEST_ACTIVITY_JSON_FIELDS = "author,comments,reviews,commits";

/** GitHub's own ceiling on a connection page, which is what both thread reads ask for. */
const GRAPHQL_PAGE_SIZE = 100;

/**
 * The ceiling on `search`, which refuses anything larger with EXCESSIVE_PAGINATION (measured:
 * `first: 101` is an error, `first: 100` is not).
 */
export const PULL_REQUEST_SEARCH_MAX_ROWS = GRAPHQL_PAGE_SIZE;

/**
 * Every repository of a host in one read, which is what makes a listing one request rather than
 * one process per repository.
 *
 * `additions` and `deletions` are deliberately absent: measured over twelve repositories at a
 * hundred rows, this query answers in ~4.0s with them left out and ~7.1s with them in, for two
 * numbers at the end of a row. They are read afterwards, by `buildPullRequestStatsGraphQlQuery`.
 *
 * The row count is written into the document rather than sent as a variable because every
 * variable here travels as a string — and it is this module's own number, clamped by the caller,
 * never a reader's.
 *
 * `first` on the two inner connections is a bound rather than a page: a pull request with more
 * than twenty labels shows twenty, and one that has asked more than twenty people for a review
 * is already past what a row can say.
 */
export function pullRequestSearchGraphQlQuery(rows: number): string {
  return `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${Math.min(Math.max(Math.trunc(rows), 1), PULL_REQUEST_SEARCH_MAX_ROWS)}) {
    pageInfo { hasNextPage }
    nodes {
      ... on PullRequest {
        number
        title
        url
        author { login avatarUrl ... on User { name } }
        headRefName
        baseRefName
        state
        isDraft
        mergeable
        reviewDecision
        createdAt
        updatedAt
        mergedAt
        repository { nameWithOwner }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        labels(first: 20) { nodes { name color } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;
}

/**
 * One page of review threads with their comments, and the people on the review. `$cursor` is
 * null for the first page and the last page's `endCursor` after that, so a pull request with
 * more threads than one page holds is walked rather than cut off at the first fifty.
 *
 * Reviewers come from here rather than from `gh pr view --json reviewRequests` for two reasons:
 * that field holds only requests still outstanding, so anyone who has already reviewed drops off
 * it, and neither it nor any other `gh` JSON field carries an avatar. A reviewer can be a person
 * or an app, and both are asked for by name because they are different GraphQL types.
 *
 * `viewerCanUpdate` and `viewerDidAuthor` ride along here for the same reason: they belong to the
 * pull request this query is already standing on, so what the reader may do with it arrives with
 * the conversation rather than costing a request of its own.
 *
 * Commits are asked for with `last` rather than `first`: `gh pr view --json commits` pages from
 * the start, so a pull request with more than a hundred commits loses the newest ones from its
 * view entirely. This query gives back the newest hundred, which is what a reader scoping a diff
 * wants, and stands in for the `gh` list wherever it came back non-empty.
 */
export const REVIEW_THREADS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${GRAPHQL_PAGE_SIZE}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          comments(first: ${GRAPHQL_PAGE_SIZE}) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { id author { login avatarUrl } body createdAt url ${REACTION_GROUPS_FIELDS} }
          }
        }
      }
      viewerCanUpdate
      viewerDidAuthor
      author { login avatarUrl }
      ${REACTION_GROUPS_FIELDS}
      comments(first: ${GRAPHQL_PAGE_SIZE}) {
        nodes { id author { login avatarUrl } ${REACTION_GROUPS_FIELDS} }
      }
      reviews(first: ${GRAPHQL_PAGE_SIZE}) { nodes { id ${REACTION_GROUPS_FIELDS} } }
      reviewRequests(first: 50) {
        nodes {
          requestedReviewer {
            ... on User { login name avatarUrl }
            ... on Bot { login avatarUrl }
          }
        }
      }
      latestReviews(first: 50) {
        nodes { author { login avatarUrl } }
      }
      reviewDismissals: timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], first: ${GRAPHQL_PAGE_SIZE}) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on ReviewDismissedEvent { dismissalMessage review { id } } }
      }
      commits(last: ${GRAPHQL_PAGE_SIZE}) {
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
            additions
            deletions
            authors(first: 3) { nodes { name avatarUrl user { login } } }
          }
        }
      }
    }
  }
}`;

/**
 * The rest of one thread's conversation. GraphQL pages a connection nested inside another only
 * from the inner node itself, so a thread longer than a page is followed on its own — a request
 * GitHub makes necessary, and one no ordinary pull request ever provokes.
 */
export const REVIEW_THREAD_COMMENTS_GRAPHQL_QUERY = `query($threadId: ID!, $cursor: String) {
  viewer { login }
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: ${GRAPHQL_PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id author { login avatarUrl } body createdAt url ${REACTION_GROUPS_FIELDS} }
      }
    }
  }
}`;

const RawReviewThreadCommentsSchema = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.optional(
      Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
    /** Null for an id that names nothing the viewer can read, which is not a thread to page. */
    node: Schema.NullOr(Schema.Struct({ comments: Schema.optional(RawThreadCommentsSchema) })),
  }),
});

export const REVIEW_THREAD_REPLY_GRAPHQL_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

/**
 * The pull request's own node id, which is what a reaction on its description is addressed by.
 * Read only when one is being written: the conversation carries an id for every remark in it, and
 * the pull request is the one subject nothing in it names.
 */
export const PULL_REQUEST_NODE_ID_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

const RawPullRequestNodeIdSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({ id: Schema.String }),
    }),
  }),
});

const decodePullRequestNodeId = decodeJsonResult(RawPullRequestNodeIdSchema);

export function decodePullRequestNodeIdJson(raw: string): Result.Result<string, DecodeFailure> {
  const decoded = decodePullRequestNodeId(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success.data.repository.pullRequest.id)
    : Result.fail(decoded.failure);
}

/**
 * Where a client-given reaction subject actually hangs: the pull request itself, or the pull
 * request an issue comment, a review comment, or a review belongs to. Read before a mutation
 * reaches it, so a subject named for one pull request cannot react on another's behalf.
 */
export const REACTION_SUBJECT_PULL_REQUEST_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $subjectId: ID!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
  node(id: $subjectId) {
    id
    ... on IssueComment { pullRequest { id } }
    ... on PullRequestReviewComment { pullRequest { id } }
    ... on PullRequestReview { pullRequest { id } }
  }
}`;

const RawReactionSubjectScopeSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({ pullRequest: Schema.NullOr(Schema.Struct({ id: Schema.String })) }),
    ),
    node: Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        pullRequest: Schema.optional(Schema.Struct({ id: Schema.String })),
      }),
    ),
  }),
});

const decodeReactionSubjectScope = decodeJsonResult(RawReactionSubjectScopeSchema);

/**
 * True when the subject named is the pull request itself, or hangs off it — false for anything
 * else, including a subject or a pull request this host could not find.
 */
export function decodeReactionSubjectScopeJson(raw: string): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeReactionSubjectScope(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const expected = decoded.success.data.repository?.pullRequest?.id ?? null;
  const node = decoded.success.data.node;
  const actual = node === null ? null : (node.pullRequest?.id ?? node.id);
  return Result.succeed(expected !== null && actual !== null && expected === actual);
}

export const ADD_REACTION_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`;

export const REMOVE_REACTION_GRAPHQL_MUTATION = `mutation($subjectId: ID!, $content: ReactionContent!) {
  removeReaction(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`;

export const RESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

export const UNRESOLVE_REVIEW_THREAD_GRAPHQL_MUTATION = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`;

/**
 * Rewrites the pull request's own words. Both are nullable so that one document serves a change
 * to the title, to the description, or to the two together: a variable the request does not send
 * puts no entry in the input at all, which leaves that field as it was rather than clearing it.
 */
export const UPDATE_PULL_REQUEST_GRAPHQL_MUTATION = `mutation($pullRequestId: ID!, $title: String, $body: String) {
  updatePullRequest(input: { pullRequestId: $pullRequestId, title: $title, body: $body }) {
    pullRequest { id }
  }
}`;

/**
 * The two comment mutations name their comment differently. The variable is spelled the same in
 * both, so a rewrite sends one set of variables whichever kind of remark it is.
 */
export const UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION = `mutation($commentId: ID!, $body: String!) {
  updateIssueComment(input: { id: $commentId, body: $body }) { issueComment { id } }
}`;

export const UPDATE_REVIEW_COMMENT_GRAPHQL_MUTATION = `mutation($commentId: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) {
    pullRequestReviewComment { id }
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

/** The body of `POST /repos/{owner}/{repo}/pulls/{number}/reviews`, which sends a review whole. */
const ReviewSubmissionSchema = Schema.Struct({
  event: Schema.Literals(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
  body: Schema.String,
  comments: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      line: Schema.Int,
      side: Schema.Literals(["LEFT", "RIGHT"]),
      body: Schema.String,
    }),
  ),
});

const encodeReviewSubmission = Schema.encodeSync(Schema.fromJsonString(ReviewSubmissionSchema));

const REVIEW_EVENTS: Record<PullRequestReviewVerdict, "COMMENT" | "APPROVE" | "REQUEST_CHANGES"> = {
  comment: "COMMENT",
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
};

/**
 * The dismissal events past the page the thread read carries. A pull request rarely has any:
 * this is followed only while the embedded page reports more.
 */
export const REVIEW_DISMISSALS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], first: ${GRAPHQL_PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on ReviewDismissedEvent { dismissalMessage review { id } } }
      }
    }
  }
}`;

/** The whole review as one request body, which is how GitHub keeps it invisible until sent. */
export function buildReviewSubmissionJson(input: {
  readonly verdict: PullRequestReviewVerdict;
  readonly body: string;
  readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
}): string {
  return encodeReviewSubmission({
    event: REVIEW_EVENTS[input.verdict],
    body: input.body,
    comments: input.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side === "left" ? ("LEFT" as const) : ("RIGHT" as const),
      body: comment.body,
    })),
  });
}

/**
 * `viewerPermission` rides along with the merge settings rather than being asked for on its own:
 * `gh repo view --json` serves both out of the same GraphQL repository object, so the viewer's
 * standing on the repository costs no request of its own.
 */
export const REPOSITORY_ACCESS_JSON_FIELDS =
  "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerPermission";

export interface GitHubPullRequestListItem {
  /** The author's node id, kept so a batch can resolve the avatar the listing does not carry. */
  readonly authorId: string | null;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  /** Null where GitHub has no verdict to summarise, which includes a draft nobody has reviewed. */
  readonly reviewDecision: PullRequestReviewDecision | null;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  /** At least one outstanding request targets a team rather than an individual login. */
  readonly hasTeamReviewRequest: boolean;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  /** Null where the head commit reported no checks, which is not the same as passing none. */
  readonly checksState: PullRequestChecksState | null;
}

export interface GitHubPullRequestDetail extends GitHubPullRequestListItem {
  /** The owner of the head branch's repository; null where `gh` did not say. */
  readonly headRepositoryOwner: string | null;
  readonly body: string;
  readonly changedFiles: number;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  /** Absent where `gh` did not answer for auto-merge at all, which is not the same as off. */
  readonly autoMergeEnabled?: boolean;
}

export interface GitHubPullRequestActivity {
  readonly author: PullRequestActor | null;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Null once a connection has nothing further, which is what ends every walk below. GitHub sends
 * an `endCursor` on a page that is also the last one, so the flag is what decides, not the
 * cursor's presence.
 */
function nextCursorOf(
  pageInfo: Schema.Schema.Type<typeof RawPageInfoSchema> | undefined,
): string | null {
  return pageInfo?.hasNextPage === true ? trimmed(pageInfo.endCursor) : null;
}

/**
 * The viewer's standing on one pull request. The two halves take opposite defaults on purpose.
 *
 * Updating is a permission, so an install that does not report it grants it and lets the host's
 * own refusal explain anything that fails. Authorship is not a permission but a fact about who
 * wrote the thing, and it is read to decide what an author may do to their own change — so an
 * unknown answer is "not the author", which grants nothing it should not.
 */
function toPullRequestViewerFields(
  raw: Schema.Schema.Type<typeof RawViewerFieldsSchema> | null | undefined,
): { readonly canUpdate: boolean; readonly didAuthor: boolean } {
  return { canUpdate: raw?.viewerCanUpdate !== false, didAuthor: raw?.viewerDidAuthor === true };
}

function toActor(raw: Schema.Schema.Type<typeof RawActorSchema> | null | undefined) {
  const login = trimmed(raw?.login);
  return login === null
    ? null
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatarUrl) };
}

function toCommitActor(
  raw: NonNullable<Schema.Schema.Type<typeof RawCommitSchema>["authors"]>[number],
): PullRequestActor | null {
  // An email-linked GitHub account has a login; an unlinked signature only has a name or email.
  // Keep that signature visible instead of silently turning a co-authored commit into one author.
  const login = trimmed(raw.login) ?? trimmed(raw.name) ?? trimmed(raw.email);
  return login === null ? null : { login, name: trimmed(raw.name), avatarUrl: null };
}

/** An author off the GraphQL commits connection, which names an account by `user.login` where
 *  `gh pr view --json commits` names it by a flat `login` copied off the signature. */
function toGraphqlCommitActor(raw: {
  readonly name?: string | null | undefined;
  readonly avatarUrl?: string | null | undefined;
  readonly user?: { readonly login?: string | null | undefined } | null | undefined;
}): PullRequestActor | null {
  const login = trimmed(raw.user?.login) ?? trimmed(raw.name);
  return login === null
    ? null
    : { login, name: trimmed(raw.name), avatarUrl: trimmed(raw.avatarUrl) };
}

function toState(raw: {
  readonly state?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
}): PullRequestState {
  if (trimmed(raw.mergedAt) !== null) return "merged";
  const state = raw.state?.trim().toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

function toMergeability(value: string | null | undefined): PullRequestMergeability {
  switch (value?.trim().toUpperCase()) {
    case "MERGEABLE":
      return "mergeable";
    case "CONFLICTING":
      return "conflicting";
    default:
      return "unknown";
  }
}

function toReviewDecision(value: string | null | undefined): PullRequestReviewDecision | null {
  switch (value?.trim().toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return null;
  }
}

function toLabels(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawLabelSchema>> | undefined,
): ReadonlyArray<PullRequestLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label.name);
    return name === null ? [] : [{ name, color: trimmed(label.color) }];
  });
}

/**
 * User review requests only. Team requests are tracked separately because a slug cannot be
 * compared with the viewer's login.
 */
function toReviewRequestLogins(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawReviewRequestSchema>> | undefined,
): ReadonlyArray<string> {
  return (raw ?? []).flatMap((request) => {
    const login = trimmed(request.login);
    return login === null ? [] : [login];
  });
}

function hasTeamReviewRequest(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawReviewRequestSchema>> | undefined,
): boolean {
  return (raw ?? []).some(
    (request) =>
      trimmed(request.login) === null &&
      (trimmed(request.slug) !== null || trimmed(request.name) !== null),
  );
}

function toCheckStatus(raw: Schema.Schema.Type<typeof RawCheckSchema>): PullRequestCheckStatus {
  // Commit statuses report a single `state`; check runs report `status` plus a `conclusion`
  // that only exists once the run has completed.
  const status = raw.status?.trim().toUpperCase();
  if (status !== undefined && status !== "COMPLETED" && status !== "") {
    return "pending";
  }
  switch ((raw.conclusion ?? raw.state)?.trim().toUpperCase()) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    // A completed check asking for manual intervention is blocking, not neutral.
    case "ACTION_REQUIRED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "neutral";
  }
}

/** What GitHub writes where a run has not reached that moment yet, which is not a time. */
const UNSET_TIMESTAMP = "0001-01-01T00:00:00Z";

function realTimestamp(value: string | null | undefined): string | null {
  const at = trimmed(value);
  return at === null || at === UNSET_TIMESTAMP ? null : at;
}

/** Only a row the rollup gives no name of any kind, which is not a check anyone can show. */
function isNamelessCheck(raw: Schema.Schema.Type<typeof RawCheckSchema>): boolean {
  return trimmed(raw.name) === null && trimmed(raw.context) === null;
}

/**
 * The rollup as the deduper reads it: a check, the workflow that owns it, and when the run last
 * had something to say. A queued run reports a completion time it has not reached, so the start
 * stands in for it rather than sorting the newest run to the bottom.
 */
function toCheckEntries(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawCheckSchema>> | null | undefined,
): ReadonlyArray<{
  readonly check: PullRequestCheck;
  readonly workflowName: string | null;
  readonly at: string | null;
}> {
  return (raw ?? []).flatMap((check) => {
    const name = trimmed(check.name) ?? trimmed(check.context);
    if (name === null) return [];
    return [
      {
        check: {
          name,
          status: toCheckStatus(check),
          description: trimmed(check.description),
          url: trimmed(check.detailsUrl) ?? trimmed(check.targetUrl),
        },
        workflowName: trimmed(check.workflowName),
        at: realTimestamp(check.completedAt) ?? realTimestamp(check.startedAt),
      },
    ];
  });
}

/**
 * The one word a listing row has space for. A failure outranks anything still running, the way
 * GitHub's own indicator reads: a run that has already gone red will not go green by finishing.
 *
 * Null rather than "passing" for a head commit with no checks at all, so a repository that runs
 * none shows nothing instead of a green tick it never earned. Checks whose verdict is neither a
 * pass, a failure nor a wait — skipped, cancelled, neutral — count towards neither.
 *
 * Counted off the deduped checks rather than the raw rollup, so the word and the list under it
 * cannot disagree: the run a re-run replaced is not a verdict twice. A row with no name at all is
 * counted as it comes, since the cross-repository search dresses GitHub's own rollup enum as one
 * nameless row, and nothing nameless can collide with anything.
 */
function rollupChecksState(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawCheckSchema>> | null | undefined,
): PullRequestChecksState | null {
  const statuses = [
    ...toChecks(raw).map((check) => check.status),
    ...(raw ?? []).filter(isNamelessCheck).map((check) => toCheckStatus(check)),
  ];
  if (statuses.length === 0) return null;
  if (statuses.includes("failure")) return "failing";
  if (statuses.includes("pending")) return "pending";
  return statuses.includes("success") ? "passing" : null;
}

function toChecks(
  raw: ReadonlyArray<Schema.Schema.Type<typeof RawCheckSchema>> | null | undefined,
): ReadonlyArray<PullRequestCheck> {
  return dedupeChecks(toCheckEntries(raw));
}

/** The states that are a verdict in themselves, rather than a wrapper around line comments. */
function isReviewVerdict(reviewState: string | null): boolean {
  switch (reviewState?.toUpperCase()) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "DISMISSED":
      return true;
    default:
      return false;
  }
}

function toComments(raw: {
  readonly comments?: ReadonlyArray<Schema.Schema.Type<typeof RawCommentSchema>> | undefined;
  readonly reviews?: ReadonlyArray<Schema.Schema.Type<typeof RawReviewSchema>> | undefined;
}): ReadonlyArray<PullRequestComment> {
  const issueComments = (raw.comments ?? []).map(
    (comment): PullRequestComment => ({
      id: comment.id,
      kind: "issue-comment",
      author: toActor(comment.author),
      body: comment.body ?? "",
      createdAt: comment.createdAt,
      url: trimmed(comment.url),
      path: null,
      reviewState: null,
    }),
  );
  // A review with no body is kept only when its state is the event itself — an approval, a
  // request for changes, a dismissal. GitHub also opens a bodiless `COMMENTED` review as the
  // container for line comments, and those comments are read from the review threads, so
  // keeping the container too would show a row with a name and nothing under it.
  const reviews = (raw.reviews ?? []).flatMap((review): ReadonlyArray<PullRequestComment> => {
    const submittedAt = trimmed(review.submittedAt);
    const reviewState = trimmed(review.state);
    if (
      submittedAt === null ||
      ((review.body ?? "").trim().length === 0 && !isReviewVerdict(reviewState))
    ) {
      return [];
    }
    return [
      {
        id: review.id,
        kind: "review",
        author: toActor(review.author),
        body: review.body ?? "",
        createdAt: submittedAt,
        url: trimmed(review.url),
        path: null,
        reviewState,
      },
    ];
  });
  return [...issueComments, ...reviews].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function toCommits(
  commits: ReadonlyArray<Schema.Schema.Type<typeof RawCommitSchema>> | undefined,
): ReadonlyArray<PullRequestCommit> {
  return (commits ?? []).map((commit) => ({
    oid: commit.oid,
    messageHeadline: commit.messageHeadline ?? "",
    committedDate: commit.committedDate,
    authors: (commit.authors ?? []).flatMap((author) => {
      const actor = toCommitActor(author);
      return actor === null ? [] : [actor];
    }),
  }));
}

function toListItem(raw: Schema.Schema.Type<typeof RawListItemSchema>): GitHubPullRequestListItem {
  return {
    authorId: trimmed(raw.author?.id),
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: toActor(raw.author),
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    state: toState(raw),
    isDraft: raw.isDraft ?? false,
    mergeability: toMergeability(raw.mergeable),
    reviewDecision: toReviewDecision(raw.reviewDecision),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reviewRequestLogins: toReviewRequestLogins(raw.reviewRequests),
    hasTeamReviewRequest: hasTeamReviewRequest(raw.reviewRequests),
    labels: toLabels(raw.labels),
    checksState: rollupChecksState(raw.statusCheckRollup),
  };
}

function toDetail(raw: Schema.Schema.Type<typeof RawDetailSchema>): GitHubPullRequestDetail {
  return {
    ...toListItem(raw),
    headRepositoryOwner: trimmed(raw.headRepositoryOwner?.login),
    body: raw.body ?? "",
    changedFiles: raw.changedFiles ?? 0,
    mergedAt: trimmed(raw.mergedAt),
    closedAt: trimmed(raw.closedAt),
    checks: toChecks(raw.statusCheckRollup),
    // A JSON null is GitHub saying "nobody armed this"; a missing key is GitHub not saying, and
    // the difference survives here rather than being flattened into false.
    ...(raw.autoMergeRequest === undefined
      ? {}
      : { autoMergeEnabled: raw.autoMergeRequest !== null }),
  };
}

function toActivity(raw: Schema.Schema.Type<typeof RawActivitySchema>): GitHubPullRequestActivity {
  return {
    author: toActor(raw.author),
    comments: toComments(raw),
    commits: toCommits(raw.commits),
  };
}

const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeListEntry = Schema.decodeUnknownExit(RawListItemSchema);
const decodeSearch = decodeJsonResult(RawSearchSchema);
const decodeSearchItem = Schema.decodeUnknownExit(RawSearchItemSchema);
const decodeStats = decodeJsonResult(RawStatsSchema);
const decodeDetail = decodeJsonResult(RawDetailSchema);
const decodeActivity = decodeJsonResult(RawActivitySchema);
const decodeFileEntry = Schema.decodeUnknownExit(RawPullRequestFileSchema);
const decodeRepositoryAccess = decodeJsonResult(RawRepositoryAccessSchema);
const decodeReviewThreads = decodeJsonResult(RawReviewThreadsSchema);
const decodeReviewThreadComments = decodeJsonResult(RawReviewThreadCommentsSchema);

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  /** Rows gh returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
}

/** Malformed entries are skipped rather than failing the batch: one unexpected pull request
 *  must not blank the whole list. */
export function decodePullRequestListJson(
  raw: string,
): Result.Result<GitHubPullRequestListBatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items: GitHubPullRequestListItem[] = [];
  for (const entry of decoded.success) {
    const item = decodeListEntry(entry);
    if (Exit.isSuccess(item)) {
      items.push(toListItem(item.value));
    }
  }
  return Result.succeed({ items, rawCount: decoded.success.length });
}

export interface GitHubPullRequestSearchItem extends GitHubPullRequestListItem {
  /** `owner/name` as GitHub spells it, which is how a row from a search finds its repository. */
  readonly repository: string;
}

export interface GitHubPullRequestSearchBatch {
  readonly items: ReadonlyArray<GitHubPullRequestSearchItem>;
  /** Rows the search returned, counted before decoding, so a skipped row cannot hide a next page. */
  readonly rawCount: number;
  /** More rows than this slice asked for, which is truncation for every repository in it. */
  readonly hasNextPage: boolean;
}

/**
 * A search answers with the same pull request the listing does, one connection deeper: reviewers
 * and labels arrive as connections, and the row names the repository it came from. Flattened to
 * the shape `gh pr list --json` hands over so both reads decode into one type.
 *
 * Rows that are not pull requests decode as empty and are skipped, the way a malformed listing
 * row is — `is:pr` already excludes them, and one surprise must not blank a whole host.
 */
export function decodePullRequestSearchJson(
  raw: string,
): Result.Result<GitHubPullRequestSearchBatch, DecodeFailure> {
  const decoded = decodeSearch(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const nodes = decoded.success.data.search.nodes ?? [];
  const items: GitHubPullRequestSearchItem[] = [];
  for (const entry of nodes) {
    const decodedNode = decodeSearchItem(entry);
    if (!Exit.isSuccess(decodedNode)) continue;
    const node = decodedNode.value;
    const repository = trimmed(node.repository?.nameWithOwner);
    if (repository === null) continue;
    items.push({
      ...toListItem({
        ...node,
        reviewRequests: (node.reviewRequests?.nodes ?? []).flatMap((request) => {
          const login = trimmed(request?.requestedReviewer?.login);
          return login === null ? [] : [{ login }];
        }),
        labels: (node.labels?.nodes ?? []).flatMap((label) => (label === null ? [] : [label])),
        // The search asks for the verdict rather than the checks behind it, so it arrives as one
        // enum. Dressed as a single check here so the rollup is read the same way on both paths.
        statusCheckRollup: (node.commits?.nodes ?? []).flatMap((commitNode) => {
          const state = trimmed(commitNode?.commit?.statusCheckRollup?.state);
          return state === null ? [] : [{ state }];
        }),
      }),
      repository,
    });
  }
  return Result.succeed({
    items,
    rawCount: nodes.length,
    hasNextPage: decoded.success.data.search.pageInfo?.hasNextPage ?? false,
  });
}

/** What a repository selector may hold before it is written into a GraphQL document unquoted. */
const REPOSITORY_PART = /^[A-Za-z0-9._-]+$/;

/**
 * The line counts for rows a listing already handed over, as one aliased lookup each.
 *
 * Aliases rather than `nodes(ids:)` because the caller asks in the terms the page holds — a
 * repository and a number — and never sees a node id. Owner, name and number are written into
 * the document, so each is checked against what GitHub can actually name first: null for anything
 * else, which the caller reports rather than sends.
 *
 * Null too for an empty request, since a GraphQL document with no selection is not a document.
 */
export function buildPullRequestStatsGraphQlQuery(
  changeRequests: ReadonlyArray<{ readonly repository: string; readonly number: number }>,
): string | null {
  if (changeRequests.length === 0) return null;
  const selections: string[] = [];
  for (const [index, changeRequest] of changeRequests.entries()) {
    const [owner, name, ...rest] = changeRequest.repository.trim().split("/");
    if (rest.length > 0 || owner === undefined || name === undefined) return null;
    if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) return null;
    if (!Number.isSafeInteger(changeRequest.number) || changeRequest.number <= 0) return null;
    selections.push(
      `  s${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${changeRequest.number}) { additions deletions } }`,
    );
  }
  return `query {\n${selections.join("\n")}\n}`;
}

/**
 * The counts by the position they were asked in. A repository or a pull request GitHub answered
 * nothing for is simply absent, which leaves the row with whatever it already had.
 */
export function decodePullRequestStatsJson(
  raw: string,
): Result.Result<
  ReadonlyMap<number, { readonly additions: number; readonly deletions: number }>,
  DecodeFailure
> {
  const decoded = decodeStats(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const stats = new Map<number, { readonly additions: number; readonly deletions: number }>();
  for (const [alias, value] of Object.entries(decoded.success.data ?? {})) {
    const index = /^s(\d+)$/.exec(alias)?.[1];
    const pullRequest = value?.pullRequest;
    if (index === undefined || pullRequest == null) continue;
    stats.set(Number(index), {
      additions: pullRequest.additions ?? 0,
      deletions: pullRequest.deletions ?? 0,
    });
  }
  return Result.succeed(stats);
}

export function decodePullRequestDetailJson(
  raw: string,
): Result.Result<GitHubPullRequestDetail, DecodeFailure> {
  const decoded = decodeDetail(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toDetail(decoded.success))
    : Result.fail(decoded.failure);
}

export function decodePullRequestActivityJson(
  raw: string,
): Result.Result<GitHubPullRequestActivity, DecodeFailure> {
  const decoded = decodeActivity(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed(toActivity(decoded.success))
    : Result.fail(decoded.failure);
}

export interface GitHubReviewThreadComments {
  readonly comments: ReadonlyArray<PullRequestComment>;
  /** Dismissal reasons by the dismissed review's node id, read off the timeline. */
  readonly dismissalsByReviewId: ReadonlyMap<string, string>;
  /** Whole conversations, kept anchored so the diff can pin them to their line. */
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  /** The host's own count of the conversation, which a bounded read can fall short of. */
  readonly commentCount: number;
  readonly truncated: boolean;
  /** The pull request's own reactions, which sit on its description. */
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  /** Reactions by node id, for the comments and reviews the `gh` JSON read carries no reaction on. */
  readonly reactionsById: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
  /**
   * Everyone on the review: those still asked and those who have already answered. Whoever has
   * reviewed is no longer an outstanding request, so asking only for requests reports nobody on
   * a pull request that has in fact been reviewed.
   */
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  /**
   * Avatars by login, for the actors `gh pr view --json` reports without one — which is all of
   * them, since no `gh` JSON field carries an avatar. Collected from everyone this query names,
   * so an app's avatar arrives the same way a person's does.
   */
  readonly avatarsByLogin: ReadonlyMap<string, string>;
  /** Per-commit line counts carried by the same bounded pull-request query. */
  readonly commitStats: ReadonlyMap<
    string,
    { readonly additions: number; readonly deletions: number }
  >;
  /**
   * The newest hundred commits, oldest to newest, off the same query's `commits(last: ...)`.
   * Empty wherever the read never happened (an install too old for the field, a degraded page),
   * which the caller reads as "keep the `gh pr view` list" rather than as "this pull request has
   * no commits".
   */
  readonly commits: ReadonlyArray<PullRequestCommit>;
  /** What GitHub says the reader may do with this pull request, read off the same response. */
  readonly viewer: { readonly canUpdate: boolean; readonly didAuthor: boolean };
}

/** One thread as this page found it, with what it takes to finish reading it. */
export interface GitHubReviewThreadEntry {
  readonly thread: PullRequestReviewThread;
  /** How many comments GitHub says the thread holds, read or not. */
  readonly commentCount: number;
  /** Where the rest of this thread's comments carry on from, or null once it is whole. */
  readonly nextCommentCursor: string | null;
}

export interface GitHubReviewThreadPage {
  readonly threads: ReadonlyArray<GitHubReviewThreadEntry>;
  /** Where the next page of threads starts, or null once the host has handed them all over. */
  readonly nextCursor: string | null;
  /** The pull request's own reactions, which sit on its description. */
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  /**
   * Reactions by node id, for the conversation comments and reviews `gh pr view --json` answers
   * for without any. Only ids with a reaction are here; the rest carry none.
   */
  readonly reactionsById: ReadonlyMap<string, ReadonlyArray<PullRequestReaction>>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly avatarsByLogin: ReadonlyMap<string, string>;
  readonly commitStats: ReadonlyMap<
    string,
    { readonly additions: number; readonly deletions: number }
  >;
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly viewer: { readonly canUpdate: boolean; readonly didAuthor: boolean };
  /** Dismissal reasons by the dismissed review's node id, which the review itself never carries. */
  readonly dismissalsByReviewId: ReadonlyMap<string, string>;
  /** Where the rest of the dismissal events start, or null once this page carried them all. */
  readonly nextDismissalCursor: string | null;
}

/**
 * The threads as one flat conversation, which is what the timeline reads. Every comment of
 * every thread, resolved or not: a resolved conversation is still what was said, and a reply is
 * as much of it as the remark it answers.
 */
export function reviewThreadConversation(
  threads: ReadonlyArray<PullRequestReviewThread>,
): ReadonlyArray<PullRequestComment> {
  return threads.flatMap((thread) =>
    thread.comments.map(
      (comment): PullRequestComment => ({
        id: comment.id,
        kind: "review-comment",
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
        url: comment.url,
        path: thread.path,
        reviewState: null,
        reactions: comment.reactions ?? [],
      }),
    ),
  );
}

/** One page of review threads. Following the cursors it hands back is the caller's job. */
function toDismissalEntries(
  nodes:
    | ReadonlyArray<{
        readonly dismissalMessage?: string | null | undefined;
        readonly review?: { readonly id?: string | null | undefined } | null | undefined;
      }>
    | undefined,
): Map<string, string> {
  const entries = new Map<string, string>();
  for (const node of nodes ?? []) {
    const reviewId = trimmed(node.review?.id);
    const message = trimmed(node.dismissalMessage);
    if (reviewId !== null && message !== null) entries.set(reviewId, message);
  }
  return entries;
}

const RawReviewDismissalsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        timelineItems: Schema.Struct({
          pageInfo: Schema.optional(RawPageInfoSchema),
          nodes: Schema.Array(
            Schema.Struct({
              dismissalMessage: Schema.optional(Schema.NullOr(Schema.String)),
              review: Schema.optional(
                Schema.NullOr(Schema.Struct({ id: Schema.optional(Schema.NullOr(Schema.String)) })),
              ),
            }),
          ),
        }),
      }),
    }),
  }),
});

const decodeReviewDismissals = decodeJsonResult(RawReviewDismissalsSchema);

/** One further page of dismissal events, in the shape the thread read's own page carries. */
export function decodeReviewDismissalsJson(raw: string): Result.Result<
  {
    readonly dismissalsByReviewId: ReadonlyMap<string, string>;
    readonly nextCursor: string | null;
  },
  DecodeFailure
> {
  const decoded = decodeReviewDismissals(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const items = decoded.success.data.repository.pullRequest.timelineItems;
  return Result.succeed({
    dismissalsByReviewId: toDismissalEntries(items.nodes),
    nextCursor: nextCursorOf(items.pageInfo),
  });
}

export function decodeReviewThreadsJson(
  raw: string,
): Result.Result<GitHubReviewThreadPage, DecodeFailure> {
  const decoded = decodeReviewThreads(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const viewer = trimmed(decoded.success.data.viewer?.login);
  const threads = decoded.success.data.repository.pullRequest.reviewThreads;
  const entries = threads.nodes.flatMap((thread): ReadonlyArray<GitHubReviewThreadEntry> => {
    const path = trimmed(thread.path);
    const id = trimmed(thread.id);
    if (path === null || id === null || thread.comments.nodes.length === 0) return [];
    return [
      {
        thread: {
          id,
          path,
          // Null once the thread's line has left the diff, which is exactly when GitHub reports
          // it outdated. Such a thread is listed rather than pinned to a line it no longer has.
          line:
            thread.line !== null && thread.line !== undefined && thread.line > 0
              ? thread.line
              : null,
          side: thread.diffSide?.toUpperCase() === "LEFT" ? "left" : "right",
          isResolved: thread.isResolved === true,
          isOutdated: thread.isOutdated === true,
          comments: thread.comments.nodes.map((comment) => ({
            id: comment.id,
            author: toActor(comment.author),
            body: comment.body ?? "",
            createdAt: comment.createdAt,
            url: trimmed(comment.url),
            reactions: toReactions(comment.reactionGroups, viewer),
          })),
        },
        commentCount: thread.comments.totalCount ?? thread.comments.nodes.length,
        nextCommentCursor: nextCursorOf(thread.comments.pageInfo),
      },
    ];
  });
  const pullRequest = decoded.success.data.repository.pullRequest;
  const avatarsByLogin = new Map<string, string>();
  for (const raw of [
    pullRequest.author,
    ...(pullRequest.comments?.nodes ?? []).map((node) => node.author),
    ...(pullRequest.reviewRequests?.nodes ?? []).map((node) => node.requestedReviewer),
    ...(pullRequest.latestReviews?.nodes ?? []).map((node) => node.author),
    ...threads.nodes.flatMap((thread) => thread.comments.nodes.map((comment) => comment.author)),
  ]) {
    const login = trimmed(raw?.login);
    const avatarUrl = trimmed(raw?.avatarUrl);
    if (login !== null && avatarUrl !== null) avatarsByLogin.set(login, avatarUrl);
  }
  const reviewers = new Map<string, PullRequestActor>();
  for (const raw of [
    ...(pullRequest.reviewRequests?.nodes ?? []).map((node) => node.requestedReviewer),
    ...(pullRequest.latestReviews?.nodes ?? []).map((node) => node.author),
  ]) {
    const actor = toActor(raw);
    // Keyed by login, so someone who was asked and then answered appears once.
    if (actor !== null && !reviewers.has(actor.login)) reviewers.set(actor.login, actor);
  }
  const commitStats = new Map<string, { readonly additions: number; readonly deletions: number }>();
  const commits: PullRequestCommit[] = [];
  for (const node of pullRequest.commits?.nodes ?? []) {
    const commit = node.commit;
    const oid = trimmed(commit.oid);
    if (oid === null) continue;
    if (commit.additions !== undefined && commit.deletions !== undefined) {
      commitStats.set(oid, {
        additions: Math.max(0, commit.additions),
        deletions: Math.max(0, commit.deletions),
      });
    }
    const committedDate = trimmed(commit.committedDate);
    if (committedDate === null) continue;
    commits.push({
      oid,
      messageHeadline: commit.messageHeadline ?? "",
      committedDate,
      authors: (commit.authors?.nodes ?? []).flatMap((author) => {
        const actor = toGraphqlCommitActor(author);
        return actor === null ? [] : [actor];
      }),
    });
  }
  const reactionsById = new Map<string, ReadonlyArray<PullRequestReaction>>();
  for (const node of [
    ...(pullRequest.comments?.nodes ?? []),
    ...(pullRequest.reviews?.nodes ?? []),
  ]) {
    const id = trimmed(node.id);
    if (id === null) continue;
    const reactions = toReactions(node.reactionGroups, viewer);
    if (reactions.length > 0) reactionsById.set(id, reactions);
  }
  return Result.succeed({
    threads: entries,
    nextCursor: nextCursorOf(threads.pageInfo),
    reactions: toReactions(pullRequest.reactionGroups, viewer),
    reactionsById,
    reviewers: [...reviewers.values()],
    avatarsByLogin,
    commitStats,
    commits,
    viewer: toPullRequestViewerFields(pullRequest),
    dismissalsByReviewId: toDismissalEntries(pullRequest.reviewDismissals?.nodes),
    nextDismissalCursor: nextCursorOf(pullRequest.reviewDismissals?.pageInfo),
  });
}

/** The rest of one thread's comments, in the shape the first page already delivered them. */
export function decodeReviewThreadCommentsJson(raw: string): Result.Result<
  {
    readonly comments: ReadonlyArray<PullRequestThreadComment>;
    readonly nextCursor: string | null;
  },
  DecodeFailure
> {
  const decoded = decodeReviewThreadComments(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const viewer = trimmed(decoded.success.data.viewer?.login);
  const comments = decoded.success.data.node?.comments;
  return Result.succeed({
    comments: (comments?.nodes ?? []).map((comment) => ({
      id: comment.id,
      author: toActor(comment.author),
      body: comment.body ?? "",
      createdAt: comment.createdAt,
      url: trimmed(comment.url),
      reactions: toReactions(comment.reactionGroups, viewer),
    })),
    nextCursor: nextCursorOf(comments?.pageInfo),
  });
}

/** What one `gh repo view` answers: what the repository allows, and where the viewer stands. */
export interface GitHubRepositoryAccess {
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  readonly canWrite: boolean;
}

/**
 * Whether the viewer's role on the repository is one that can push, which is what merging needs.
 * TRIAGE and READ are not: a triager moves issues about and neither of them lands a commit.
 *
 * An install that reports no permission at all does not count as write. This is the exception to
 * "an unknown permission is granted": write is what merging and closing somebody else's change
 * need, and offering those to a reader who cannot use them wastes the press and reads as the app
 * being wrong. Everything softer — commenting, reviewing, resolving — keeps the granting default,
 * because being unable to say something is the worse failure there.
 */
function toCanWrite(viewerPermission: string | null | undefined): boolean {
  switch (viewerPermission?.trim().toUpperCase()) {
    case "ADMIN":
    case "MAINTAIN":
    case "WRITE":
      return true;
    default:
      return false;
  }
}

export function decodeRepositoryAccessJson(
  raw: string,
): Result.Result<GitHubRepositoryAccess, DecodeFailure> {
  const decoded = decodeRepositoryAccess(raw);
  return Result.isSuccess(decoded)
    ? Result.succeed({
        mergeCapabilities: {
          merge: decoded.success.mergeCommitAllowed,
          squash: decoded.success.squashMergeAllowed,
          rebase: decoded.success.rebaseMergeAllowed,
        },
        canWrite: toCanWrite(decoded.success.viewerPermission),
      })
    : Result.fail(decoded.failure);
}

/**
 * Who a review may be asked of, and who it has already been asked of, in one read.
 *
 * `assignableUsers` is the list GitHub's own reviewer picker is built from — everyone with access
 * to the repository — rather than `collaborators`, which the REST API refuses to anyone without
 * push access and which would therefore be empty for exactly the reader most likely to be looking.
 *
 * Teams are asked for only where one has already been requested, so a request to a team can be
 * taken back. The teams a repository could newly be sent to live on the owning organization and
 * need `read:org`, which a repository-scoped token need not carry — and a query GitHub refuses
 * fails whole, taking the people down with the teams.
 */
/**
 * Where the branch stands against its base, and whether this viewer may move it.
 *
 * `mergeStateStatus` is not the answer: GitHub only reports BEHIND where the repository requires
 * branches to be up to date before merging, so on every other repository a stale branch reads as
 * CLEAN or BLOCKED like any other. The comparison counts the commits instead, which is the same
 * number GitHub's own "out-of-date" banner shows.
 *
 * `headRef` is qualified `owner:branch` because a pull request from a fork has no branch of that
 * name in the base repository, and an unqualified name is simply not found there.
 */
export const BASE_COMPARISON_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      viewerCanUpdateBranch
      baseRef {
        compare(headRef: $headRef) {
          behindBy
        }
      }
    }
  }
}`;

const RawBaseComparisonSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            viewerCanUpdateBranch: Schema.optional(Schema.NullOr(Schema.Boolean)),
            /** Null where the head repository is gone, which is a comparison nobody can make. */
            baseRef: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  compare: Schema.optional(
                    Schema.NullOr(Schema.Struct({ behindBy: Schema.Number })),
                  ),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeBaseComparison = decodeJsonResult(RawBaseComparisonSchema);

export interface GitHubBaseComparison {
  /** Null where the host could not compare, which the page reads as "unknown". */
  readonly behindBy: number | null;
  readonly viewerCanUpdate: boolean;
}

export function decodeBaseComparisonJson(
  raw: string,
): Result.Result<GitHubBaseComparison, DecodeFailure> {
  const decoded = decodeBaseComparison(raw);
  if (!Result.isSuccess(decoded)) return Result.fail(decoded.failure);
  const pullRequest = decoded.success.data.repository?.pullRequest;
  const behindBy = pullRequest?.baseRef?.compare?.behindBy;
  return Result.succeed({
    behindBy: typeof behindBy === "number" && behindBy >= 0 ? behindBy : null,
    viewerCanUpdate: pullRequest?.viewerCanUpdateBranch === true,
  });
}

export const REVIEWER_CANDIDATES_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: ${GRAPHQL_PAGE_SIZE}) {
      pageInfo { hasNextPage }
      nodes { login name avatarUrl }
    }
    pullRequest(number: $number) {
      author { login }
      reviewRequests(first: ${GRAPHQL_PAGE_SIZE}) {
        nodes {
          requestedReviewer {
            ... on User { login name avatarUrl }
            ... on Team { slug name avatarUrl }
            ... on Bot { login avatarUrl }
          }
        }
      }
    }
  }
}`;

/** A team answers with a slug where a user answers with a login, and nothing else differs. */
const RawRequestedReviewerSchema = Schema.Struct({
  ...RawActorSchema.fields,
  slug: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawReviewerCandidatesSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      assignableUsers: Schema.Struct({
        pageInfo: Schema.optional(RawPageInfoSchema),
        nodes: Schema.Array(Schema.NullOr(RawActorSchema)),
      }),
      /** Null for a number that names no pull request the viewer can see. */
      pullRequest: Schema.NullOr(
        Schema.Struct({
          author: Schema.optional(Schema.NullOr(RawActorSchema)),
          reviewRequests: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({
                    requestedReviewer: Schema.optional(Schema.NullOr(RawRequestedReviewerSchema)),
                  }),
                ),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});

const decodeReviewerCandidates = decodeJsonResult(RawReviewerCandidatesSchema);

/**
 * The people this pull request may be sent to, with whoever is already on it marked. The author is
 * dropped rather than shown as an unusable row: GitHub refuses a review request from the person
 * who opened the pull request, so offering them is offering a failure.
 *
 * Whoever has been asked leads the list even where GitHub does not count them assignable — an
 * outside collaborator, an app — because a request that cannot be seen cannot be taken back.
 */
export function decodeReviewerCandidatesJson(
  raw: string,
): Result.Result<PullRequestReviewerCandidateList, DecodeFailure> {
  const decoded = decodeReviewerCandidates(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const repository = decoded.success.data.repository;
  const pullRequest = repository.pullRequest;
  const author = trimmed(pullRequest?.author?.login);
  const candidates = new Map<string, PullRequestReviewerCandidate>();
  for (const node of pullRequest?.reviewRequests?.nodes ?? []) {
    const raw = node.requestedReviewer;
    const slug = trimmed(raw?.slug);
    const id = slug ?? trimmed(raw?.login);
    if (id === null) continue;
    candidates.set(`${slug === null ? "user" : "team"} ${id}`, {
      id,
      kind: slug === null ? "user" : "team",
      login: id,
      name: trimmed(raw?.name),
      avatarUrl: trimmed(raw?.avatarUrl),
      isRequested: true,
    });
  }
  for (const node of repository.assignableUsers.nodes) {
    const login = trimmed(node?.login);
    if (login === null || login === author || candidates.has(`user ${login}`)) continue;
    candidates.set(`user ${login}`, {
      id: login,
      kind: "user",
      login,
      name: trimmed(node?.name),
      avatarUrl: trimmed(node?.avatarUrl),
      isRequested: false,
    });
  }
  return Result.succeed({
    candidates: [...candidates.values()],
    truncated: repository.assignableUsers.pageInfo?.hasNextPage === true,
  });
}

/**
 * The body of `POST`/`DELETE /repos/{owner}/{repo}/pulls/{number}/requested_reviewers`, which
 * takes people and teams in two lists of its own. The same body serves both methods, because
 * GitHub takes a request back from exactly whoever it was made of.
 */
const ReviewerRequestSchema = Schema.Struct({
  reviewers: Schema.Array(Schema.String),
  team_reviewers: Schema.Array(Schema.String),
});

const encodeReviewerRequest = Schema.encodeSync(Schema.fromJsonString(ReviewerRequestSchema));

export function buildReviewerRequestJson(
  reviewers: ReadonlyArray<{ readonly id: string; readonly kind: PullRequestReviewerKind }>,
): string {
  return encodeReviewerRequest({
    reviewers: reviewers.flatMap((reviewer) => (reviewer.kind === "user" ? [reviewer.id] : [])),
    team_reviewers: reviewers.flatMap((reviewer) =>
      reviewer.kind === "team" ? [reviewer.id] : [],
    ),
  });
}

/**
 * Everything GitHub says about what the signed-in account may do here. `canWrite` is about the
 * repository, the other two about this pull request in particular — which is why an author with
 * only read access can still be told apart from a passer-by.
 */
export interface GitHubViewerAccess {
  readonly canWrite: boolean;
  /** GitHub's own `viewerCanUpdate`, true for the author as well as for anyone with write. */
  readonly canUpdate: boolean;
  readonly didAuthor: boolean;
  /**
   * GitHub's own `viewerCanUpdateBranch`, read with the base comparison rather than here: it is
   * false for a branch that is already current, so it answers "may update, and there is
   * something to update" at once. Absent where the comparison was not read.
   */
  readonly canUpdateBranch?: boolean;
}

/**
 * The viewer's standing, asked on its own. Only the write path needs this: reading a pull request
 * already carries the same three fields on calls it was making anyway, and this exists so that a
 * merge or a close is decided by what GitHub says now rather than by what the page was told when
 * it loaded.
 */
export const VIEWER_PERMISSIONS_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequest(number: $number) { viewerCanUpdate viewerDidAuthor }
  }
}`;

const RawViewerPermissionsSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      viewerPermission: Schema.optional(Schema.NullOr(Schema.String)),
      /** Null for a number that names no pull request the viewer can see. */
      pullRequest: Schema.NullOr(RawViewerFieldsSchema),
    }),
  }),
});

const decodeViewerPermissions = decodeJsonResult(RawViewerPermissionsSchema);

export function decodeViewerPermissionsJson(
  raw: string,
): Result.Result<GitHubViewerAccess, DecodeFailure> {
  const decoded = decodeViewerPermissions(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const repository = decoded.success.data.repository;
  return Result.succeed({
    canWrite: toCanWrite(repository.viewerPermission),
    ...toPullRequestViewerFields(repository.pullRequest),
  });
}

export interface GitHubPullRequestFilesPatch {
  readonly patch: string;
  /** At least one file's hunks were withheld by GitHub, so they are missing from the patch. */
  readonly truncated: boolean;
  /** Files GitHub returned, counted before decoding, so the caller can page. */
  readonly rawCount: number;
  /** GitHub's own counts for the files whose hunks it withheld. */
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

/**
 * The files API returns hunks per file with no `diff --git` header, so the unified patch every
 * diff viewer expects is assembled here. This decodes one page; walking pages is the caller's
 * job, which is why the raw file count comes back with the patch.
 */
export function decodePullRequestFilesJson(
  raw: string,
): Result.Result<GitHubPullRequestFilesPatch, DecodeFailure> {
  const decoded = decodeUnknownList(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const sections: string[] = [];
  const omittedFileStats: PullRequestOmittedFileStat[] = [];
  let truncated = false;
  for (const entry of decoded.success) {
    const file = decodeFileEntry(entry);
    if (Exit.isFailure(file)) continue;
    const value = file.value;
    const hunks = value.patch ?? "";
    const status = value.status?.trim().toLowerCase();
    if (hunks.length === 0) {
      // A file with no hunks is still a file that changed: a pure rename has none to give, and
      // a binary one has none that can be shown. Both are listed, and only the second is a hole
      // in the patch — leaving them out entirely would drop them from the change altogether.
      const additions = value.additions ?? 0;
      const deletions = value.deletions ?? 0;
      if (additions + deletions > 0) {
        truncated = true;
        omittedFileStats.push({ path: value.filename, additions, deletions });
      }
    }
    // A rename counts its hunks against the old path, which is the only place it is named.
    const oldPath =
      status === "renamed" ? (trimmed(value.previous_filename) ?? value.filename) : value.filename;
    const header = [
      `diff --git a/${oldPath} b/${value.filename}`,
      // The files API reports no file mode, so the ordinary one stands in: the viewer reads
      // these lines as "added" and "removed" rather than for the mode they carry.
      ...(status === "added" ? ["new file mode 100644"] : []),
      ...(status === "removed" ? ["deleted file mode 100644"] : []),
      ...(status === "renamed" ? [`rename from ${oldPath}`, `rename to ${value.filename}`] : []),
      `--- ${status === "added" ? "/dev/null" : `a/${oldPath}`}`,
      `+++ ${status === "removed" ? "/dev/null" : `b/${value.filename}`}`,
    ].join("\n");
    sections.push(hunks.length === 0 ? `${header}\n` : `${header}\n${hunks.replace(/\n?$/, "\n")}`);
  }
  return Result.succeed({
    patch: sections.join(""),
    truncated,
    rawCount: decoded.success.length,
    omittedFileStats,
  });
}
