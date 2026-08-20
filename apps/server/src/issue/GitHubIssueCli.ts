import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  IssueAction,
  IssueAssigneeCandidateList,
  IssueCloseReason,
  IssueComment,
  IssueEvent,
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueLabelCandidate,
  IssueLabelCandidateList,
  IssueListState,
  IssueReactionContent,
  IssueTemplate,
  IssueTemplateList,
  IssueActor,
} from "@t3tools/contracts";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  ADD_REACTION_GRAPHQL_MUTATION,
  REMOVE_REACTION_GRAPHQL_MUTATION,
  gitHubReactionContent,
} from "../sourceControl/gitHubReactionJson.ts";
import {
  ASSIGNEE_CANDIDATES_GRAPHQL_QUERY,
  buildIssueWriteJson,
  decodeAssigneeCandidatesJson,
  decodeCreatedIssueJson,
  decodeIssueActivityJson,
  decodeIssueCommentsJson,
  decodeIssueCommentScopeJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssueNodeIdJson,
  decodeIssueSearchJson,
  decodeIssueSupplementJson,
  DEFAULT_ISSUE_TEMPLATE_CONFIG,
  decodeIssueTemplateConfigYaml,
  decodeIssueTemplateFormsJson,
  decodeIssueTemplatesJson,
  decodeIssueViewerPermissionsJson,
  decodeRepositoryLabelsJson,
  encodeGraphQlRequestJson,
  issueSearchGraphQlQuery,
  ISSUE_ACTIVITY_GRAPHQL_QUERY,
  ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY,
  ISSUE_COMMENTS_GRAPHQL_QUERY,
  ISSUE_DETAIL_JSON_FIELDS,
  ISSUE_LIST_JSON_FIELDS,
  ISSUE_NODE_ID_GRAPHQL_QUERY,
  ISSUE_SEARCH_MAX_RESULTS,
  ISSUE_SEARCH_MAX_ROWS,
  ISSUE_SUPPLEMENT_GRAPHQL_QUERY,
  ISSUE_TEMPLATES_GRAPHQL_QUERY,
  ISSUE_TEMPLATE_FORMS_GRAPHQL_QUERY,
  ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
  UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION,
  type GitHubIssue,
  type GitHubIssueDetail,
  type GitHubIssueSearchBatch as GitHubSearchPage,
  type GitHubIssueSearchItem,
  type GitHubIssueSupplement,
  type GitHubIssueViewerAccess,
  type IssueWriteFields,
} from "./gitHubIssueJson.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitHubIssueReadError extends Schema.TaggedErrorClass<GitHubIssueReadError>()(
  "GitHubIssueReadError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitHub CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: gh answered, the account it answered for just has no login. */
export class GitHubIssueViewerLoginUnavailableError extends Schema.TaggedErrorClass<GitHubIssueViewerLoginUnavailableError>()(
  "GitHubIssueViewerLoginUnavailableError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitHub CLI returned no login for the authenticated account.";
  }

  override get message(): string {
    return `GitHub CLI failed in getViewerLogin: ${this.detail}`;
  }
}

/**
 * Not a failure of the read but an answer to it: this repository keeps no issues, because the
 * setting that would let it is switched off. Told apart from an ordinary refusal so the page can
 * explain the setting rather than report a fault nobody can act on.
 */
export class GitHubIssuesDisabledError extends Schema.TaggedErrorClass<GitHubIssuesDisabledError>()(
  "GitHubIssuesDisabledError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    repository: Schema.String,
  },
) {
  get detail(): string {
    return `Issues are switched off for ${this.repository}.`;
  }

  override get message(): string {
    return `GitHub CLI failed in listIssues: ${this.detail}`;
  }
}

/**
 * Not a decode failure: a repository was named that cannot go into a search or into a GraphQL
 * document as itself. Every qualifier below is composed from `owner/name`, so a name that is not
 * one is refused here rather than escaped into something GitHub might read as a qualifier of its
 * own.
 */
export class GitHubIssueRepositorySelectorError extends Schema.TaggedErrorClass<GitHubIssueRepositorySelectorError>()(
  "GitHubIssueRepositorySelectorError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  get detail(): string {
    return "A repository was named that GitHub cannot address.";
  }

  override get message(): string {
    return `GitHub CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitHubIssueCommentScopeError extends Schema.TaggedErrorClass<GitHubIssueCommentScopeError>()(
  "GitHubIssueCommentScopeError",
  { command: Schema.Literal("gh"), cwd: Schema.String },
) {
  get detail(): string {
    return "The comment does not belong to the selected issue.";
  }

  override get message(): string {
    return `GitHub CLI failed in updateComment: ${this.detail}`;
  }
}

export type GitHubIssueCliError =
  | GitHubCli.GitHubCliError
  | GitHubIssueReadError
  | GitHubIssueViewerLoginUnavailableError
  | GitHubIssuesDisabledError
  | GitHubIssueCommentScopeError
  | SourceControlRateLimit.SourceControlRateLimitPausedError
  | GitHubIssueRepositorySelectorError;

/** Where a repository configures the rest of its issue chooser, as GitHub itself spells the path. */
const TEMPLATE_CONFIG_PATH = ".github/ISSUE_TEMPLATE/config.yml";

/** What the labels API serves at most in one response, and pages of them before it is truncated:
 *  five hundred labels is already more than any repository offers a picker for. */
const LABEL_PAGE_SIZE = 100;
const LABEL_PAGES = 5;

/** A repository's label before the issue it is offered for says whether it is on it. */
type LabelCandidate = Omit<IssueLabelCandidate, "isApplied">;

export interface GitHubIssueListBatch {
  readonly items: ReadonlyArray<GitHubIssue>;
  readonly truncated: boolean;
  /** False for a page GitHub would not search, which came back in `gh`'s own order instead. */
  readonly continues: boolean;
}

export interface GitHubIssueSearchBatch {
  readonly items: ReadonlyArray<GitHubIssueSearchItem>;
  readonly truncated: boolean;
}

export interface GitHubIssueActivity {
  readonly author: IssueActor | null;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly nextCommentsCursor: string | null;
  readonly events: ReadonlyArray<IssueEvent>;
}

export interface GitHubIssueCommentsPage {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly nextCursor: string | null;
}

export class GitHubIssueCli extends Context.Service<
  GitHubIssueCli,
  {
    readonly getViewerLogin: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<string, GitHubIssueCliError>;

    readonly listIssues: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly sort?: IssueListSort | undefined;
      readonly order?: IssueListOrder | undefined;
      /** Free text for `--search`, matched as one literal phrase. */
      readonly query?: string | undefined;
      /** Where to carry on from, as an `updated:` qualifier on the same search. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<GitHubIssueListBatch, GitHubIssueCliError>;

    /**
     * The same listing for a whole host in one search. `limit` is the size of the slice across
     * all of the repositories rather than per repository, because that is what a search answers:
     * the newest rows of the lot, which is exactly the page.
     */
    readonly searchIssues: (input: {
      /** Any checkout on the host; the search names its repositories itself. */
      readonly cwd: string;
      readonly host: string;
      readonly repositories: ReadonlyArray<string>;
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly sort?: IssueListSort | undefined;
      readonly order?: IssueListOrder | undefined;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<GitHubIssueSearchBatch, GitHubIssueCliError>;

    readonly getIssueDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubIssueDetail, GitHubIssueCliError>;

    /** The one GraphQL read that answers everything `gh issue view --json` cannot. */
    readonly getIssueSupplement: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubIssueSupplement, GitHubIssueCliError>;

    readonly getIssueActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubIssueActivity, GitHubIssueCliError>;

    readonly getIssueComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly cursor: string;
    }) => Effect.Effect<GitHubIssueCommentsPage, GitHubIssueCliError>;

    /** The viewer's standing on its own, for deciding a write without reading the whole issue. */
    readonly getViewerAccess: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubIssueViewerAccess, GitHubIssueCliError>;

    readonly runIssueAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly action: IssueAction;
      readonly reason?: IssueCloseReason | undefined;
    }) => Effect.Effect<void, GitHubIssueCliError>;

    readonly commentOnIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubIssueCliError>;

    readonly createIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly title: string;
      readonly body: string;
      readonly labels: ReadonlyArray<string>;
      readonly assignees: ReadonlyArray<string>;
    }) => Effect.Effect<{ readonly number: number; readonly url: string }, GitHubIssueCliError>;

    readonly updateIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, GitHubIssueCliError>;

    readonly updateComment: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitHubIssueCliError>;

    readonly setReaction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: IssueReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitHubIssueCliError>;

    readonly setLabels: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
    }) => Effect.Effect<void, GitHubIssueCliError>;

    readonly setAssignees: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      /** Logins, as the candidate list handed them out. */
      readonly assignees: ReadonlyArray<string>;
    }) => Effect.Effect<void, GitHubIssueCliError>;

    readonly listLabelCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<IssueLabelCandidateList, GitHubIssueCliError>;

    readonly listAssigneeCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<IssueAssigneeCandidateList, GitHubIssueCliError>;

    /**
     * What this repository offers somebody filing a new issue: its templates, and the config file
     * beside them that says where else a question could go and whether a blank issue is allowed.
     */
    readonly listIssueTemplates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
    }) => Effect.Effect<IssueTemplateList, GitHubIssueCliError>;
  }
>()("t3/issue/GitHubIssueCli") {}

/**
 * The GraphQL and REST APIs take owner and name as separate arguments, so `owner/repo` is split
 * here. The host is not read off the identity: it travels alongside it, because the identity a
 * project records is the path below its host and never names the host itself.
 */
function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/** What a repository selector may hold before it goes into a search as itself. */
const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The reader's own words as one literal phrase of a GitHub search query. Quoting is the whole
 * defence: outside quotes GitHub reads `is:closed` as a qualifier and `label:x` as another, so
 * text typed into a search box could widen the very listing it is meant to narrow — inside them it
 * is only text. The two characters that could end the phrase early are therefore escaped first,
 * which GitHub reads back as themselves; an unbalanced quote is dropped instead, which would let
 * everything after it out of the phrase.
 */
function searchPhrase(query: string): string {
  return `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The narrowings `gh issue list` has flags of its own for. Involvement is one of them: GitHub
 * matches an assignee, an author and a mention itself, so none of the three has to be spelled as a
 * search qualifier — which is what lets the search-free fallback below narrow the same way.
 */
function involvementArgs(input: {
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
}): ReadonlyArray<string> {
  switch (input.involvement) {
    case "assigned":
      return ["--assignee", input.viewer];
    case "authored":
      return ["--author", input.viewer];
    case "mentioned":
      return ["--mention", input.viewer];
    case "all":
      return [];
  }
}

const GITHUB_SORT: Readonly<Record<IssueListSort, string | null>> = {
  "best-match": null,
  created: "created",
  updated: "updated",
  comments: "comments",
  reactions: "reactions",
  "reactions-thumbs-up": "reactions-+1",
  "reactions-thumbs-down": "reactions--1",
  "reactions-rocket": "reactions-rocket",
  "reactions-hooray": "reactions-tada",
  "reactions-eyes": "reactions-eyes",
  "reactions-heart": "reactions-heart",
  "reactions-laugh": "reactions-smile",
  "reactions-confused": "reactions-thinking_face",
};

function supportsIssueCursor(input: {
  readonly sort?: IssueListSort | undefined;
  readonly order?: IssueListOrder | undefined;
}) {
  return (input.sort ?? "updated") === "updated" && (input.order ?? "desc") === "desc";
}

/**
 * The one `--search` argument, which is where the order, the continuation and the reader's text
 * end up.
 *
 * `is:issue` leads it because GitHub's search index holds pull requests as issues: without the
 * qualifier a repository's pull requests arrive on the issues page as issues.
 */
function searchTerms(input: {
  readonly sort?: IssueListSort | undefined;
  readonly order?: IssueListOrder | undefined;
  readonly query?: string | undefined;
  readonly cursor?: ProviderListCursor | undefined;
}): string {
  const query = input.query?.trim() ?? "";
  return [
    "is:issue",
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    // The instant the last slice ended on, and everything before it. Inclusive, because rows
    // sharing one instant are ordinary and the caller drops the ones it has already sent — asking
    // for strictly older would lose the rest of them instead.
    ...(input.cursor === undefined || !supportsIssueCursor(input)
      ? []
      : [`updated:<=${input.cursor.updatedBefore}`]),
    // Updated-desc stays the default because it is the only order the timestamp cursor can carry.
    // An explicit best-match choice omits the qualifier and preserves GitHub's ranking.
    ...(GITHUB_SORT[input.sort ?? "updated"] === null
      ? []
      : [`sort:${GITHUB_SORT[input.sort ?? "updated"]}-${input.order ?? "desc"}`]),
  ].join(" ");
}

/**
 * The same listing as one GitHub search across several repositories, which is the only way to read
 * a whole host in one request.
 *
 * Every narrowing `involvementArgs` hands to `gh issue list` as a flag is a qualifier here instead,
 * because a search has no flags to borrow. The two belong together; a tab added to one wants adding
 * to the other.
 *
 * Null where a repository is not `owner/name`. A name is written into the query as itself, and a
 * name holding a space could otherwise end the `repo:` qualifier and start a qualifier of its own —
 * so an unaddressable one refuses the whole read rather than being escaped into something GitHub
 * might still read.
 */
function searchQuery(input: {
  readonly repositories: ReadonlyArray<string>;
  readonly state: IssueListState;
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly cursor?: ProviderListCursor | undefined;
}): string | null {
  if (input.repositories.length === 0) return null;
  const repositories = input.repositories.map((repository) => repository.trim());
  if (!repositories.every((repository) => SEARCH_REPOSITORY.test(repository))) return null;
  return [
    // `type: ISSUE` is the index pull requests share with issues, so this is what keeps them out.
    searchTerms(input),
    // "all" is every state, which the search already is.
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed"] : []),
    ...(input.involvement === "assigned" ? [`assignee:${input.viewer}`] : []),
    ...(input.involvement === "authored" ? [`author:${input.viewer}`] : []),
    ...(input.involvement === "mentioned" ? [`mentions:${input.viewer}`] : []),
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(" ");
}

/**
 * How many rows a slice may hand over: the page that was asked for, plus the rest of the instant it
 * would otherwise stop inside.
 *
 * A continuation is an instant asked for inclusively plus the rows already sent at it, so a slice
 * that ends halfway through one instant cannot be carried on from at all: the read after it asks
 * the same question, is handed the same rows, drops every one of them as already sent, and works
 * out the cursor it started with. One afternoon of triage touches more issues in a second than a
 * page holds, and the listing would stand on that second for good. Handing the instant over whole
 * is what makes that impossible — the read after it drops the whole group and carries on with rows
 * that are strictly older — and it is why a slice may run a little past the page it was asked for.
 */
function wholeInstantRows(
  items: ReadonlyArray<{ readonly updatedAt: string }>,
  limit: number,
): number {
  const last = items[Math.min(limit, items.length) - 1];
  if (last === undefined) return 0;
  let rows = Math.min(limit, items.length);
  while (items[rows]?.updatedAt === last.updatedAt) rows += 1;
  return rows;
}

/**
 * Whether the instant the slice ends on runs to the end of what was read, which is the only reason
 * to read further: the rest of that instant is somewhere past the rows in hand. A slice holding
 * less than the page it asked for has nothing at its edge to be split.
 */
function instantRunsOn(
  items: ReadonlyArray<{ readonly updatedAt: string }>,
  limit: number,
  rows: number,
): boolean {
  return items.length >= limit && rows === items.length;
}

/**
 * The `after` a paged read carries. gh sends a JSON null only through a typed field, and an untyped
 * `cursor=` would send the empty string, which GitHub refuses as a cursor rather than reading as
 * "start at the beginning".
 */
function cursorVariable(cursor: string | null): readonly [string, string] {
  return cursor === null ? ["-F", "cursor=null"] : ["-f", `cursor=${cursor}`];
}

/** GitHub spells the reason for a close with a space in it, and takes no other words. */
function closeReasonArgs(reason: IssueCloseReason | undefined): ReadonlyArray<string> {
  if (reason === undefined) return [];
  return ["--reason", reason === "completed" ? "completed" : "not planned"];
}

export const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const graphQlBudget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;

  // `gh` resolves a bare `owner/repo` against whichever host it defaults to, which is github.com.
  // Naming the host makes a GitHub Enterprise repository resolve to its own install rather than to
  // a same-named repository on github.com.
  const repositoryArgs = (input: { readonly host: string; readonly repository: string }) => [
    "--repo",
    `${input.host}/${input.repository}`,
  ];

  const readError =
    (input: { readonly cwd: string; readonly operation: string }) => (cause: unknown) =>
      new GitHubIssueReadError({
        command: "gh",
        cwd: input.cwd,
        operation: input.operation,
        cause,
      });

  /** A GraphQL read whose answer is decoded, reporting a failure against the read that made it. */
  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    /** Variables as `-f` flags, for values this module composed itself. */
    readonly variables?: ReadonlyArray<readonly [string, string]>;
    /**
     * Variables carrying words the reader typed. Document and variables travel over stdin
     * together, because argv is visible in process listings and is echoed back inside a
     * process-runner failure message.
     */
    readonly privateVariables?: Readonly<Record<string, string>>;
    readonly query: string;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, GitHubIssueCliError> =>
    Effect.gen(function* () {
      const query = yield* graphQlBudget.query(input.host, input.query);
      const result = yield* github.execute(
        input.privateVariables === undefined
          ? {
              cwd: input.cwd,
              args: [
                "api",
                "graphql",
                "--hostname",
                input.host,
                ...(input.variables ?? []).flat(),
                "-f",
                `query=${query}`,
              ],
            }
          : {
              cwd: input.cwd,
              args: ["api", "graphql", "--hostname", input.host, "--input", "-"],
              stdin: encodeGraphQlRequestJson({
                query,
                variables: input.privateVariables,
              }),
            },
      );
      yield* graphQlBudget.observe(input.host, result.stdout);
      const decoded = input.decode(result.stdout.trim());
      return Result.isSuccess(decoded) ? decoded.success : yield* readError(input)(decoded.failure);
    });

  const graphql = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, string>>;
  }) =>
    github
      .execute({
        cwd: input.cwd,
        args: ["api", "graphql", "--hostname", input.host, "--input", "-"],
        stdin: encodeGraphQlRequestJson({ query: input.query, variables: input.variables }),
      })
      .pipe(Effect.asVoid);

  const commentBelongsToIssue = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly commentId: string;
  }) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "updateComment",
      variables: [
        ["-f", `owner=${owner}`],
        ["-f", `name=${name}`],
        ["-F", `number=${input.number}`],
        ["-f", `commentId=${input.commentId}`],
      ],
      query: ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY,
      decode: decodeIssueCommentScopeJson,
    });
  };

  const issueNodeId = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
  }): Effect.Effect<string, GitHubIssueCliError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "setReaction",
      variables: [
        ["-f", `owner=${owner}`],
        ["-f", `name=${name}`],
        ["-F", `number=${input.number}`],
      ],
      query: ISSUE_NODE_ID_GRAPHQL_QUERY,
      decode: decodeIssueNodeIdJson,
    });
  };

  /**
   * Every write to an issue is the same REST call, so its body is the only thing that differs.
   * The REST road rather than `gh issue edit`: a title and a body are the reader's own words, and
   * `--title` would put them in argv, which is visible in process listings and echoed back inside
   * process-runner failure messages. Labels and assignees are written the same way because this
   * endpoint replaces both, which is the whole-set write the page asks for.
   */
  const writeIssue = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly body: IssueWriteFields;
  }) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return github
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          "--method",
          "PATCH",
          "--hostname",
          input.host,
          `repos/${owner}/${name}/issues/${input.number}`,
          "--input",
          "-",
        ],
        stdin: buildIssueWriteJson(input.body),
      })
      .pipe(Effect.asVoid);
  };

  const issueDetail: GitHubIssueCli["Service"]["getIssueDetail"] = (input) =>
    github
      .execute({
        cwd: input.cwd,
        args: [
          "issue",
          "view",
          String(input.number),
          ...repositoryArgs(input),
          "--json",
          ISSUE_DETAIL_JSON_FIELDS,
        ],
      })
      .pipe(
        Effect.flatMap((result) => {
          const decoded = decodeIssueDetailJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                readError({ cwd: input.cwd, operation: "getIssueDetail" })(decoded.failure),
              );
        }),
      );

  /**
   * Whether this repository keeps issues at all. Asked only once a listing has already been
   * refused, so a repository that answers costs nothing: a switched-off tracker fails every read
   * the same way an unreachable repository does, and only this says which of the two it was.
   */
  const issuesDisabled = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
  }) =>
    github
      .execute({
        cwd: input.cwd,
        args: [
          "repo",
          "view",
          `${input.host}/${input.repository}`,
          "--json",
          "hasIssuesEnabled",
          "--jq",
          ".hasIssuesEnabled",
        ],
      })
      .pipe(
        Effect.map((result) => result.stdout.trim() === "false"),
        // A probe that fails says nothing, which leaves the original refusal to speak.
        Effect.orElseSucceed(() => false),
      );

  const repositoryLabels = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
  }) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const page = (
      pageNumber: number,
      collected: ReadonlyArray<LabelCandidate>,
    ): Effect.Effect<
      { readonly labels: ReadonlyArray<LabelCandidate>; readonly truncated: boolean },
      GitHubIssueCliError
    > =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "api",
            "--hostname",
            input.host,
            `repos/${owner}/${name}/labels?per_page=${LABEL_PAGE_SIZE}&page=${pageNumber}`,
          ],
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodeRepositoryLabelsJson(result.stdout.trim());
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                readError({ cwd: input.cwd, operation: "listLabelCandidates" })(decoded.failure),
              );
            }
            const labels = [...collected, ...decoded.success.labels];
            // Counted before decoding, so a skipped malformed label cannot end paging early.
            if (decoded.success.rawCount < LABEL_PAGE_SIZE) {
              return Effect.succeed({ labels, truncated: false });
            }
            return pageNumber >= LABEL_PAGES
              ? Effect.succeed({ labels, truncated: true })
              : page(pageNumber + 1, labels);
          }),
        );
    return page(1, []);
  };

  return GitHubIssueCli.of({
    getViewerLogin: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: ["api", "user", "--hostname", input.host, "--jq", ".login"],
        })
        .pipe(
          Effect.flatMap((result) => {
            const login = result.stdout.trim();
            return login.length > 0
              ? Effect.succeed(login)
              : Effect.fail(
                  new GitHubIssueViewerLoginUnavailableError({ command: "gh", cwd: input.cwd }),
                );
          }),
        ),

    listIssues: (input) => {
      const read = (
        continues: boolean,
        // One extra row reveals that the repository has more than the page shows, and a read that
        // ended inside one instant asks again with room for the whole of it.
        rows: number = input.limit + 1,
      ): Effect.Effect<GitHubIssueListBatch, GitHubIssueCliError> =>
        github
          .execute({
            cwd: input.cwd,
            args: [
              "issue",
              "list",
              ...repositoryArgs(input),
              ...involvementArgs(input),
              // The fallback read exists because this repository's search index answered nothing,
              // so it goes nowhere near search: no order, cursor or qualifiers. Its rows are
              // narrowed by the flags above and by `--state`, which is every narrowing this
              // listing asks for.
              ...(continues ? ["--search", searchTerms(input)] : []),
              "--state",
              input.state,
              "--limit",
              String(rows),
              "--json",
              ISSUE_LIST_JSON_FIELDS,
            ],
          })
          .pipe(
            Effect.flatMap((result) => {
              const raw = result.stdout.trim();
              if (raw.length === 0) {
                return Effect.succeed({ items: [], truncated: false, continues });
              }
              const decoded = decodeIssueListJson(raw);
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  readError({ cwd: input.cwd, operation: "listIssues" })(decoded.failure),
                );
              }
              // The fallback read is in no order a cursor can carry on from, so it has no instant
              // to keep whole: it hands over the page it was asked for and says so.
              if (!continues) {
                return Effect.succeed({
                  items: decoded.success.items.slice(0, input.limit),
                  // One row over the page size is the probe for a next page, and it is counted
                  // before decoding: a skipped malformed row must not end paging.
                  truncated: decoded.success.rawCount > input.limit,
                  continues,
                });
              }
              if (!supportsIssueCursor(input)) {
                return Effect.succeed({
                  items: decoded.success.items.slice(0, input.limit),
                  truncated: decoded.success.rawCount > input.limit,
                  continues: false,
                });
              }
              const handed = wholeInstantRows(decoded.success.items, input.limit);
              const runsOn =
                instantRunsOn(decoded.success.items, input.limit, handed) &&
                decoded.success.rawCount >= rows;
              // Read again with room for the rest of the instant rather than splitting it. Twice
              // the rows each time, so the ordinary tie — a handful of issues touched in the same
              // second — costs one more read, and GitHub's own ceiling on a search ends the walk.
              if (runsOn && rows < ISSUE_SEARCH_MAX_RESULTS) {
                return read(continues, Math.min(rows * 2, ISSUE_SEARCH_MAX_RESULTS));
              }
              return Effect.succeed({
                items: decoded.success.items.slice(0, handed),
                // Rows read but not handed over are the probe for a next page, counted before
                // decoding so a skipped malformed row cannot end paging.
                truncated: decoded.success.rawCount > Math.max(input.limit, handed),
                // A page still standing inside one instant at GitHub's ceiling cannot be carried
                // on from: the read after it would be handed these same rows and nothing else, so
                // the rest of that instant is reached by asking for a larger page instead.
                continues: !runsOn,
              });
            }),
          );
      // GitHub does not index every repository for search, and one it will not search answers with
      // no rows rather than with an error — so an empty listing is read again the way `gh` lists
      // without one. Those rows come back newest-created first, an order no `updated:` qualifier
      // can carry on from, so that page says it cannot be continued and the reader reaches the rest
      // of it by asking for a larger page.
      //
      // Only ever the first slice: a repository that answered the search once will answer it again,
      // so an empty slice under a cursor is a repository that has run out. A text search that finds
      // nothing has found nothing, too: falling back would answer it with the repository's whole
      // list, which is every issue the reader did not search for.
      const searched = (input.query?.trim().length ?? 0) > 0;
      return read(true).pipe(
        Effect.flatMap((batch) =>
          batch.items.length === 0 && input.cursor === undefined && !searched
            ? read(false)
            : Effect.succeed(batch),
        ),
        // A repository whose tracker is switched off refuses every issue read there is, and says
        // so in words this process never sees. Narrowed to a command that ran and was refused: a
        // missing `gh` or a signed-out one fails the same way for every repository.
        Effect.catchTags({
          GitHubCliCommandError: (error) =>
            issuesDisabled(input).pipe(
              Effect.flatMap((disabled) =>
                Effect.fail(
                  disabled
                    ? new GitHubIssuesDisabledError({
                        command: "gh",
                        cwd: input.cwd,
                        repository: input.repository,
                      })
                    : error,
                ),
              ),
            ),
        }),
      );
    },

    searchIssues: (input) => {
      const query = searchQuery(input);
      if (query === null) {
        return Effect.fail(
          new GitHubIssueRepositorySelectorError({
            command: "gh",
            cwd: input.cwd,
            operation: "searchIssues",
          }),
        );
      }
      // One extra row reveals that the host has more than the slice shows, the way the
      // per-repository read does — up to GitHub's own ceiling on a search page, past which
      // `hasNextPage` is what says there is more.
      const rows = Math.min(input.limit + 1, ISSUE_SEARCH_MAX_ROWS);
      const searchPage = (
        cursor: string | null,
        first: number,
      ): Effect.Effect<GitHubSearchPage, GitHubIssueCliError> =>
        graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "searchIssues",
          // The reader's own words are in the query, so it travels over stdin rather than in argv.
          // An absent `cursor` is the first page: GitHub reads a variable nobody sent as null.
          privateVariables: cursor === null ? { q: query } : { q: query, cursor },
          query: issueSearchGraphQlQuery(first),
          decode: decodeIssueSearchJson,
        });
      return Effect.gen(function* () {
        const items: Array<GitHubIssueSearchItem> = [];
        let read = 0;
        let cursor: string | null = null;
        let hasNextPage = false;
        let handed = 0;
        do {
          // The pages after the first are only there to finish an instant, so they are asked for
          // as wide as GitHub allows rather than as narrow as the page.
          const batch: GitHubSearchPage = yield* searchPage(
            cursor,
            read === 0 ? rows : Math.min(ISSUE_SEARCH_MAX_RESULTS - read, ISSUE_SEARCH_MAX_ROWS),
          );
          items.push(...batch.items);
          read += batch.rawCount;
          hasNextPage = batch.hasNextPage;
          cursor = batch.nextCursor;
          handed = supportsIssueCursor(input)
            ? wholeInstantRows(items, input.limit)
            : Math.min(items.length, input.limit);
        } while (
          cursor !== null &&
          read < ISSUE_SEARCH_MAX_RESULTS &&
          supportsIssueCursor(input) &&
          instantRunsOn(items, input.limit, handed)
        );
        return {
          items: items.slice(0, handed),
          // A slice still standing inside one instant has run into GitHub's ceiling on how far a
          // search may be paged, so this is every row the host will answer this query with:
          // offering a continuation would hand back a cursor answered with these same rows.
          truncated: supportsIssueCursor(input)
            ? instantRunsOn(items, input.limit, handed)
              ? false
              : read > Math.max(input.limit, handed) || hasNextPage
            : read > input.limit || hasNextPage,
        };
      });
    },

    getIssueDetail: issueDetail,

    getIssueSupplement: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getIssueSupplement",
        variables: [
          ["-f", `owner=${owner}`],
          ["-f", `name=${name}`],
          ["-F", `number=${input.number}`],
        ],
        query: ISSUE_SUPPLEMENT_GRAPHQL_QUERY,
        decode: decodeIssueSupplementJson,
      });
    },

    getIssueActivity: (input) =>
      Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        const identity = [
          ["-f", `owner=${owner}`],
          ["-f", `name=${name}`],
          ["-F", `number=${input.number}`],
        ] as const;
        const first = yield* graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "getIssueActivity",
          variables: [...identity, cursorVariable(null)],
          query: ISSUE_ACTIVITY_GRAPHQL_QUERY,
          decode: decodeIssueActivityJson,
        });
        return {
          author: first.author,
          comments: first.comments,
          commentCount: Math.max(first.commentCount, first.comments.length),
          commentsTruncated: first.nextCursor !== null,
          nextCommentsCursor: first.nextCursor,
          events: first.events,
          reactions: first.reactions,
        };
      }),

    getIssueComments: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getIssueComments",
        variables: [
          ["-f", `owner=${owner}`],
          ["-f", `name=${name}`],
          ["-F", `number=${input.number}`],
          cursorVariable(input.cursor),
        ],
        query: ISSUE_COMMENTS_GRAPHQL_QUERY,
        decode: decodeIssueCommentsJson,
      });
    },

    getViewerAccess: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "getViewerAccess",
        variables: [
          ["-f", `owner=${owner}`],
          ["-f", `name=${name}`],
          ["-F", `number=${input.number}`],
        ],
        query: ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
        decode: decodeIssueViewerPermissionsJson,
      });
    },

    runIssueAction: (input) =>
      github
        .execute({
          cwd: input.cwd,
          args: [
            "issue",
            input.action,
            String(input.number),
            ...repositoryArgs(input),
            // Only a close takes one, and only the two words GitHub knows.
            ...(input.action === "close" ? closeReasonArgs(input.reason) : []),
          ],
        })
        .pipe(Effect.asVoid),

    commentOnIssue: (input) =>
      github
        .execute({
          cwd: input.cwd,
          // The body travels over stdin: argv is visible in process listings and is echoed back
          // inside process-runner failure messages.
          args: [
            "issue",
            "comment",
            String(input.number),
            ...repositoryArgs(input),
            "--body-file",
            "-",
          ],
          stdin: input.body,
        })
        .pipe(Effect.asVoid),

    createIssue: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return github
        .execute({
          cwd: input.cwd,
          // `gh issue create --title` would put the reader's words in argv, so the new issue is
          // filed through the API instead, with title and body together in the request body.
          args: [
            "api",
            "--method",
            "POST",
            "--hostname",
            input.host,
            `repos/${owner}/${name}/issues`,
            "--input",
            "-",
          ],
          stdin: buildIssueWriteJson({
            title: input.title,
            body: input.body,
            labels: input.labels,
            assignees: input.assignees,
          }),
        })
        .pipe(
          Effect.flatMap((result) => {
            const decoded = decodeCreatedIssueJson(result.stdout.trim());
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(
                  readError({ cwd: input.cwd, operation: "createIssue" })(decoded.failure),
                );
          }),
        );
    },

    updateIssue: (input) =>
      writeIssue({
        ...input,
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        },
      }),

    updateComment: (input): Effect.Effect<void, GitHubIssueCliError> =>
      Effect.gen(function* () {
        const belongs = yield* commentBelongsToIssue(input);
        if (!belongs) {
          return yield* new GitHubIssueCommentScopeError({ command: "gh", cwd: input.cwd });
        }
        yield* graphql({
          cwd: input.cwd,
          host: input.host,
          query: UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION,
          variables: { commentId: input.commentId, body: input.body },
        });
      }),

    setReaction: (input): Effect.Effect<void, GitHubIssueCliError> => {
      const subjectId =
        input.subjectId === undefined
          ? issueNodeId(input)
          : commentBelongsToIssue({ ...input, commentId: input.subjectId }).pipe(
              Effect.flatMap((belongs) =>
                belongs
                  ? Effect.succeed(input.subjectId as string)
                  : new GitHubIssueCommentScopeError({ command: "gh", cwd: input.cwd }),
              ),
            );
      return subjectId.pipe(
        Effect.flatMap((id) =>
          graphql({
            cwd: input.cwd,
            host: input.host,
            query: input.reacted ? ADD_REACTION_GRAPHQL_MUTATION : REMOVE_REACTION_GRAPHQL_MUTATION,
            variables: { subjectId: id, content: gitHubReactionContent(input.content) },
          }),
        ),
      );
    },

    setLabels: (input) => writeIssue({ ...input, body: { labels: input.labels } }),

    setAssignees: (input) => writeIssue({ ...input, body: { assignees: input.assignees } }),

    listLabelCandidates: (input) =>
      Effect.all([issueDetail(input), repositoryLabels(input)], { concurrency: 2 }).pipe(
        Effect.map(([issue, labels]) => {
          const applied = new Set(issue.labels.map((label) => label.name));
          return {
            candidates: labels.labels.map((label) => ({
              ...label,
              isApplied: applied.has(label.name),
            })),
            truncated: labels.truncated,
          };
        }),
      ),

    listAssigneeCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listAssigneeCandidates",
        variables: [
          ["-f", `owner=${owner}`],
          ["-f", `name=${name}`],
          ["-F", `number=${input.number}`],
        ],
        query: ASSIGNEE_CANDIDATES_GRAPHQL_QUERY,
        decode: decodeAssigneeCandidatesJson,
      });
    },

    listIssueTemplates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return Effect.all(
        [
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listIssueTemplates",
            variables: [
              ["-f", `owner=${owner}`],
              ["-f", `name=${name}`],
            ],
            query: ISSUE_TEMPLATES_GRAPHQL_QUERY,
            decode: decodeIssueTemplatesJson,
          }),
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listIssueTemplateForms",
            variables: [
              ["-f", `owner=${owner}`],
              ["-f", `name=${name}`],
            ],
            query: ISSUE_TEMPLATE_FORMS_GRAPHQL_QUERY,
            decode: decodeIssueTemplateFormsJson,
          }).pipe(
            // A repository whose tree this account may not walk still has templates worth showing,
            // so the questions are lost rather than the chooser.
            Effect.orElseSucceed(() => ({
              forms: [] as ReadonlyArray<IssueTemplate>,
              contributingGuidelinesUrl: undefined,
            })),
          ),
          github
            .execute({
              cwd: input.cwd,
              args: [
                "api",
                "--hostname",
                input.host,
                // The file itself rather than the contents API's envelope, which would wrap a few
                // lines of YAML in base64 for no reason.
                "--header",
                "Accept: application/vnd.github.raw",
                `repos/${owner}/${name}/contents/${TEMPLATE_CONFIG_PATH}`,
              ],
            })
            .pipe(
              Effect.map((result) => decodeIssueTemplateConfigYaml(result.stdout)),
              // Most repositories keep no config file, which GitHub answers with a 404 — the same
              // answer as a file that configures nothing, and neither is a reason to fail a read
              // whose templates arrived.
              Effect.orElseSucceed(() => DEFAULT_ISSUE_TEMPLATE_CONFIG),
            ),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.map(([templates, forms, config]) => {
          // GitHub lists a form among its templates but reports an empty body for it, so wherever
          // the file behind a template was read as a form, the form is what the composer opens.
          const byKey = new Map(forms.forms.map((form) => [form.key, form]));
          const listed = new Set(templates.map((template) => template.key));
          return {
            templates: [
              ...templates.map((template) => byKey.get(template.key) ?? template),
              // A form GitHub did not list at all still belongs in the chooser.
              ...forms.forms.filter((form) => !listed.has(form.key)),
            ],
            ...config,
            ...(forms.contributingGuidelinesUrl === undefined
              ? {}
              : { contributingGuidelinesUrl: forms.contributingGuidelinesUrl }),
          };
        }),
      );
    },
  });
});

export const layer = Layer.effect(GitHubIssueCli, make);
