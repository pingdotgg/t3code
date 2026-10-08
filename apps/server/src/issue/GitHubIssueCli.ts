import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
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

import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Exit from "effect/Exit";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  ADD_REACTION_GRAPHQL_MUTATION,
  REMOVE_REACTION_GRAPHQL_MUTATION,
  gitHubReactionContent,
} from "../sourceControl/gitHubReactionJson.ts";
import {
  ASSIGNEE_CANDIDATES_GRAPHQL_QUERY,
  decodeAssigneeCandidatesJson,
  decodeCreatedIssueJson,
  decodeIssueActivityJson,
  decodeIssueCommentsJson,
  decodeIssueCommentScopeJson,
  decodeIssueCoreJson,
  decodeIssueSummaryBatchJson,
  buildIssueSummaryQuery,
  ISSUE_LABEL_CANDIDATES_GRAPHQL_QUERY,
  decodeIssueLabelCandidatesJson,
  ISSUE_REPOSITORY_LIST_GRAPHQL_QUERY,
  decodeIssueRepositoryListJson,
  decodeIssueNodeIdJson,
  decodeIssueSearchJson,
  DEFAULT_ISSUE_TEMPLATE_CONFIG,
  decodeIssueTemplateConfigYaml,
  decodeIssueTemplateFormsJson,
  decodeIssueTemplatesJson,
  decodeIssueViewerPermissionsJson,
  issueSearchGraphQlQuery,
  ISSUE_ACTIVITY_GRAPHQL_QUERY,
  ISSUE_COMMENT_SCOPE_GRAPHQL_QUERY,
  ISSUE_COMMENTS_GRAPHQL_QUERY,
  ISSUE_NODE_ID_GRAPHQL_QUERY,
  ISSUE_SEARCH_MAX_RESULTS,
  ISSUE_SEARCH_MAX_ROWS,
  ISSUE_SUPPLEMENT_GRAPHQL_QUERY,
  ISSUE_SUPPLEMENT_LEGACY_GRAPHQL_QUERY,
  ISSUE_TEMPLATES_GRAPHQL_QUERY,
  ISSUE_TEMPLATE_FORMS_GRAPHQL_QUERY,
  ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
  UPDATE_ISSUE_COMMENT_GRAPHQL_MUTATION,
  type GitHubIssue,
  type GitHubIssueDetail,
  type GitHubIssueCore,
  type GitHubIssueSearchBatch as GitHubSearchPage,
  type GitHubIssueSearchItem,
  type GitHubIssueViewerAccess,
  type IssueWriteFields,
} from "./gitHubIssueJson.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitHubIssueReadError extends Schema.TaggedError<GitHubIssueReadError>()(
  "GitHubIssueReadError",
  {
    command: Schema.Literal("gh"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitHub returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitHub failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * Not a failure of the read but an answer to it: this repository keeps no issues, because the
 * setting that would let it is switched off. Told apart from an ordinary refusal so the page can
 * explain the setting rather than report a fault nobody can act on.
 */
export class GitHubIssuesDisabledError extends Schema.TaggedError<GitHubIssuesDisabledError>()(
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
    return `GitHub failed in listIssues: ${this.detail}`;
  }
}

/**
 * Not a decode failure: a repository was named that cannot go into a search or into a GraphQL
 * document as itself. Every qualifier below is composed from `owner/name`, so a name that is not
 * one is refused here rather than escaped into something GitHub might read as a qualifier of its
 * own.
 */
export class GitHubIssueRepositorySelectorError extends Schema.TaggedError<GitHubIssueRepositorySelectorError>()(
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
    return `GitHub failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitHubIssueCommentScopeError extends Schema.TaggedError<GitHubIssueCommentScopeError>()(
  "GitHubIssueCommentScopeError",
  { command: Schema.Literal("gh"), cwd: Schema.String },
) {
  get detail(): string {
    return "The comment does not belong to the selected issue.";
  }

  override get message(): string {
    return `GitHub failed in updateComment: ${this.detail}`;
  }
}

export class GitHubIssueTriageRequiredError extends Schema.TaggedError<GitHubIssueTriageRequiredError>()(
  "GitHubIssueTriageRequiredError",
  { operation: Schema.Literals(["listLabelCandidates", "listAssigneeCandidates"]) },
) {
  get detail(): string {
    return this.operation === "listLabelCandidates"
      ? "You do not have permission to change labels on this issue."
      : "You do not have permission to change assignees on this issue.";
  }
  override get message(): string {
    return this.detail;
  }
}

export type GitHubIssueCliError =
  | GitHubApi.GitHubApiError
  | GitHubIssueReadError
  | GitHubIssuesDisabledError
  | GitHubIssueCommentScopeError
  | SourceControlRateLimit.SourceControlRateLimitPausedError
  | GitHubIssueRepositorySelectorError
  | GitHubIssueTriageRequiredError;

/** Where a repository configures the rest of its issue chooser, as GitHub itself spells the path. */
const TEMPLATE_CONFIG_PATH = ".github/ISSUE_TEMPLATE/config.yml";

export interface GitHubIssueListBatch {
  readonly items: ReadonlyArray<GitHubIssue>;
  readonly truncated: boolean;
  /** False for a page GitHub would not search, which came back in `gh`'s own order instead. */
  readonly continues: boolean;
}

export interface GitHubIssueSearchBatch {
  readonly items: ReadonlyArray<GitHubIssueSearchItem>;
  readonly truncated: boolean;
  readonly ceilingReached: boolean;
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

const decodeViewer = Schema.decodeResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({ viewer: Schema.Struct({ login: Schema.NonEmptyString }) }),
    }),
  ),
);
const decodeViewerLogin = (raw: string) =>
  Result.map(decodeViewer(raw), ({ data }) => data.viewer.login);

class IssueSummaryRead extends Request.Class<
  {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
  },
  Pick<GitHubIssueDetail, "number" | "title" | "url" | "state">,
  GitHubIssueCliError
> {}

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

    readonly getIssueSummary: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<
      Pick<GitHubIssueDetail, "number" | "title" | "url" | "state">,
      GitHubIssueCliError
    >;

    readonly getIssueDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubIssueCore, GitHubIssueCliError>;

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

const make = Effect.gen(function* () {
  const api = yield* GitHubApi.GitHubApi;
  const unsupportedHierarchy = yield* Cache.make({
    lookup: (host: string) => Effect.succeed(host),
    capacity: 64,
    timeToLive: Duration.minutes(10),
  });

  const readError =
    (input: { readonly cwd: string; readonly operation: string }) => (cause: unknown) =>
      new GitHubIssueReadError({
        command: "gh",
        cwd: input.cwd,
        operation: input.operation,
        cause,
      });

  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    readonly minimumCost?: number;
    readonly variables?: Readonly<Record<string, unknown>>;
    readonly query: string;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, GitHubIssueCliError> =>
    api.graphql(input).pipe(
      Effect.flatMap((raw) => {
        const decoded = input.decode(raw);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(readError(input)(decoded.failure));
      }),
    );

  const graphql = (input: {
    readonly cwd: string;
    readonly host: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, string>>;
  }) => api.graphql({ ...input, operation: "mutateIssue" }).pipe(Effect.asVoid);

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
      variables: { owner, name, number: input.number, commentId: input.commentId },
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
      variables: { owner, name, number: input.number },
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
    readonly body: IssueWriteFields & {
      readonly state?: "open" | "closed";
      readonly state_reason?: "completed" | "not_planned";
    };
  }) => {
    const { owner, name } = parseRepositorySelector(input.repository);
    return api
      .rest({
        host: input.host,
        operation: "updateIssue",
        method: "PATCH",
        path: `repos/${owner}/${name}/issues/${input.number}`,
        body: input.body,
      })
      .pipe(Effect.asVoid);
  };

  const issueDetail: GitHubIssueCli["Service"]["getIssueDetail"] = (input) =>
    Effect.gen(function* () {
      const { owner, name } = parseRepositorySelector(input.repository);
      const host = input.host.trim().toLowerCase();
      const read = (query: string) =>
        graphqlRead({
          ...input,
          operation: "getIssueDetail",
          variables: { owner, name, number: input.number },
          query,
          minimumCost: query === ISSUE_SUPPLEMENT_GRAPHQL_QUERY ? 3 : 1,
          decode: decodeIssueCoreJson,
        });
      if (yield* Cache.has(unsupportedHierarchy, host))
        return yield* read(ISSUE_SUPPLEMENT_LEGACY_GRAPHQL_QUERY);
      return yield* read(ISSUE_SUPPLEMENT_GRAPHQL_QUERY).pipe(
        Effect.catchTags({
          GitHubApiResponseError: (error) =>
            error.status === 200 &&
            error.githubErrors !== undefined &&
            error.githubErrors.length > 0 &&
            error.githubErrors.every((message) =>
              /^Field [\x27"](?:parent|subIssues)[\x27"] (?:doesn\x27t|does not) exist on type [\x27"]Issue[\x27"]$/.test(
                message,
              ),
            )
              ? Cache.set(unsupportedHierarchy, host, host).pipe(
                  Effect.andThen(read(ISSUE_SUPPLEMENT_LEGACY_GRAPHQL_QUERY)),
                )
              : Effect.fail(error),
        }),
      );
    });

  const summaryResolver = RequestResolver.makeGrouped<IssueSummaryRead, string>({
    key: ({ request, context }) =>
      JSON.stringify([
        request.host.toLowerCase(),
        Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null)
          ?.credentialFingerprint ?? null,
        Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
      ]),
    resolver: (entries) => {
      const first = entries[0]!.request;
      const emptySummaries = () =>
        Effect.succeed(
          new Map<number, Pick<GitHubIssueDetail, "number" | "title" | "url" | "state">>(),
        );
      return graphqlRead({
        ...first,
        operation: "getIssueSummary",
        query: buildIssueSummaryQuery(entries.map(({ request }) => request)),
        decode: decodeIssueSummaryBatchJson,
      }).pipe(
        Effect.catchTags({
          GitHubApiResponseError: emptySummaries,
          GitHubApiNotFoundError: emptySummaries,
          GitHubIssueReadError: emptySummaries,
        }),
        Effect.flatMap((summaries) =>
          Effect.forEach(
            entries,
            (entry, index) => {
              const summary = summaries.get(index);
              if (summary !== undefined)
                return Effect.sync(() => entry.completeUnsafe(Exit.succeed(summary)));
              return graphqlRead({
                ...entry.request,
                operation: "getIssueSummary",
                query: buildIssueSummaryQuery([entry.request]),
                decode: decodeIssueSummaryBatchJson,
              }).pipe(
                Effect.flatMap((single) => {
                  const found = single.get(0);
                  return found === undefined
                    ? Effect.fail(
                        readError({ ...entry.request, operation: "getIssueSummary" })(
                          "Issue unavailable",
                        ),
                      )
                    : Effect.succeed(found);
                }),
                Effect.exit,
                Effect.map((exit) => entry.completeUnsafe(exit)),
              );
            },
            { concurrency: 4, discard: true },
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      );
    },
  }).pipe(RequestResolver.setDelay("10 millis"), RequestResolver.batchN(25));

  const searchIssues = (
    input: Parameters<GitHubIssueCli["Service"]["searchIssues"]>[0],
    query: string,
  ) => {
    // One extra row reveals that the host has more than the slice shows, the way the
    // per-repository read does — up to GitHub's own ceiling on a search page, past which
    // `hasNextPage` is what says there is more.
    const rows = Math.min(input.limit + 1, ISSUE_SEARCH_MAX_ROWS);
    const seenAt = new Map(
      input.repositories.map((repository) => {
        const key = repository.trim().toLowerCase();
        return [
          key,
          new Set(
            input.cursor?.seenAtByRepository?.[key] ??
              (input.repositories.length === 1 ? input.cursor?.seenAt : undefined),
          ),
        ] as const;
      }),
    );
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
        variables: cursor === null ? { q: query } : { q: query, cursor },
        query: issueSearchGraphQlQuery(first),
        decode: decodeIssueSearchJson,
      });
    return Effect.gen(function* () {
      const items: Array<GitHubIssueSearchItem> = [];
      let read = 0;
      let skipped = 0;
      let cursor: string | null = null;
      let hasNextPage = false;
      let handed = 0;
      do {
        const batch: GitHubSearchPage = yield* searchPage(
          cursor,
          read === 0 ? rows : Math.min(ISSUE_SEARCH_MAX_RESULTS - read, ISSUE_SEARCH_MAX_ROWS),
        );
        const unseen = batch.items.filter(
          (item) =>
            !supportsIssueCursor(input) ||
            item.updatedAt !== input.cursor?.updatedBefore ||
            !seenAt.get(item.repository.toLowerCase())?.has(item.number),
        );
        skipped += batch.items.length - unseen.length;
        items.push(...unseen);
        read += batch.rawCount;
        hasNextPage = batch.hasNextPage;
        cursor = batch.nextCursor;
        handed = supportsIssueCursor(input)
          ? wholeInstantRows(items, input.limit)
          : Math.min(items.length, input.limit);
        if (batch.rawCount === 0) break;
      } while (
        cursor !== null &&
        read < ISSUE_SEARCH_MAX_RESULTS &&
        (items.length < input.limit ||
          (supportsIssueCursor(input) && instantRunsOn(items, input.limit, handed)))
      );
      return {
        items: items.slice(0, handed),
        // A slice still standing inside one instant has run into GitHub's ceiling on how far a
        // search may be paged, so this is every row the host will answer this query with:
        // offering a continuation would hand back a cursor answered with these same rows.
        ceilingReached:
          hasNextPage &&
          read >= ISSUE_SEARCH_MAX_RESULTS &&
          (items.length < input.limit || instantRunsOn(items, input.limit, handed)),
        truncated: supportsIssueCursor(input)
          ? instantRunsOn(items, input.limit, handed)
            ? false
            : read - skipped > Math.max(input.limit, handed) || hasNextPage
          : read - skipped > input.limit || hasNextPage,
      };
    });
  };

  return GitHubIssueCli.of({
    getViewerLogin: (input) =>
      graphqlRead({
        ...input,
        operation: "getViewerLogin",
        query: "query { viewer { login } }",
        decode: decodeViewerLogin,
      }),

    listIssues: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      const query = searchQuery({ ...input, repositories: [input.repository] });
      if (query === null)
        return Effect.fail(
          new GitHubIssueRepositorySelectorError({
            command: "gh",
            cwd: input.cwd,
            operation: "listIssues",
          }),
        );
      const fallback = () =>
        Effect.gen(function* () {
          const items: GitHubIssue[] = [];
          let cursor: string | null = null;
          let rawCount = 0;
          let hasNextPage = false;
          do {
            const batch: {
              readonly items: ReadonlyArray<GitHubIssue>;
              readonly rawCount: number;
              readonly hasNextPage: boolean;
              readonly nextCursor: string | null;
              readonly enabled: boolean;
            } = yield* graphqlRead({
              ...input,
              operation: "listIssues",
              query: ISSUE_REPOSITORY_LIST_GRAPHQL_QUERY,
              variables: {
                owner,
                name,
                cursor,
                first: Math.min(input.limit + 1 - rawCount, 100),
                states: input.state === "all" ? ["OPEN", "CLOSED"] : [input.state.toUpperCase()],
                assignee: input.involvement === "assigned" ? input.viewer : null,
                createdBy: input.involvement === "authored" ? input.viewer : null,
                mentioned: input.involvement === "mentioned" ? input.viewer : null,
              },
              decode: decodeIssueRepositoryListJson,
            });
            if (!batch.enabled)
              return yield* new GitHubIssuesDisabledError({
                command: "gh",
                cwd: input.cwd,
                repository: input.repository,
              });
            items.push(...batch.items);
            rawCount += batch.rawCount;
            cursor = batch.nextCursor;
            hasNextPage = batch.hasNextPage;
          } while (
            cursor !== null &&
            rawCount <= input.limit &&
            rawCount < ISSUE_SEARCH_MAX_RESULTS
          );
          return {
            items: items.slice(0, input.limit),
            truncated: hasNextPage || rawCount > input.limit,
            continues: false,
          };
        });
      return searchIssues({ ...input, repositories: [input.repository] }, query).pipe(
        Effect.map((batch) => ({
          ...batch,
          truncated: batch.truncated || batch.ceilingReached,
          continues: supportsIssueCursor(input) && !batch.ceilingReached,
        })),
        Effect.flatMap((batch) =>
          batch.items.length === 0 && input.cursor === undefined && !input.query?.trim()
            ? fallback()
            : Effect.succeed(batch),
        ),
      );
    },

    searchIssues: (input) => {
      const query = searchQuery(input);
      return query === null
        ? Effect.fail(
            new GitHubIssueRepositorySelectorError({
              command: "gh",
              cwd: input.cwd,
              operation: "searchIssues",
            }),
          )
        : searchIssues(input, query);
    },

    getIssueDetail: issueDetail,

    getIssueSummary: (input) =>
      SEARCH_REPOSITORY.test(input.repository) &&
      Number.isSafeInteger(input.number) &&
      input.number > 0
        ? Effect.request(new IssueSummaryRead(input), summaryResolver)
        : Effect.fail(
            new GitHubIssueRepositorySelectorError({
              command: "gh",
              cwd: input.cwd,
              operation: "getIssueSummary",
            }),
          ),

    getIssueActivity: (input) =>
      Effect.gen(function* () {
        const { owner, name } = parseRepositorySelector(input.repository);
        const identity = { owner, name, number: input.number };
        const first = yield* graphqlRead({
          cwd: input.cwd,
          host: input.host,
          operation: "getIssueActivity",
          variables: { ...identity, cursor: null },
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
        variables: { owner, name, number: input.number, cursor: input.cursor },
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
        variables: { owner, name, number: input.number },
        query: ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
        decode: decodeIssueViewerPermissionsJson,
      });
    },

    runIssueAction: (input) =>
      writeIssue({
        ...input,
        body: {
          state: input.action === "close" ? "closed" : "open",
          ...(input.action === "close" && input.reason !== undefined
            ? { state_reason: input.reason === "completed" ? "completed" : "not_planned" }
            : {}),
        },
      }),

    commentOnIssue: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return api
        .rest({
          host: input.host,
          operation: "commentOnIssue",
          method: "POST",
          path: `repos/${owner}/${name}/issues/${input.number}/comments`,
          body: { body: input.body },
        })
        .pipe(Effect.asVoid);
    },

    createIssue: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return api
        .rest({
          host: input.host,
          operation: "createIssue",
          method: "POST",
          path: `repos/${owner}/${name}/issues`,
          body: {
            title: input.title,
            body: input.body,
            labels: input.labels,
            assignees: input.assignees,
          },
        })
        .pipe(
          Effect.flatMap((response) => {
            const decoded = decodeCreatedIssueJson(response.body);
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success)
              : Effect.fail(readError({ ...input, operation: "createIssue" })(decoded.failure));
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

    listLabelCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return Effect.gen(function* () {
        let cursor: string | null = null;
        const candidates: IssueLabelCandidate[] = [];
        for (let page = 0; page < 5; page++) {
          const batch: {
            readonly candidates: ReadonlyArray<IssueLabelCandidate>;
            readonly nextCursor: string | null;
            readonly canTriage: boolean;
          } = yield* graphqlRead({
            ...input,
            operation: "listLabelCandidates",
            variables: { owner, name, number: input.number, cursor },
            query: ISSUE_LABEL_CANDIDATES_GRAPHQL_QUERY,
            decode: decodeIssueLabelCandidatesJson,
          });
          if (!batch.canTriage)
            return yield* new GitHubIssueTriageRequiredError({ operation: "listLabelCandidates" });
          candidates.push(...batch.candidates);
          cursor = batch.nextCursor;
          if (cursor === null) return { candidates, truncated: false };
        }
        return { candidates, truncated: true };
      });
    },

    listAssigneeCandidates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "listAssigneeCandidates",
        variables: { owner, name, number: input.number },
        query: ASSIGNEE_CANDIDATES_GRAPHQL_QUERY,
        decode: (raw) =>
          Result.flatMap(decodeIssueViewerPermissionsJson(raw), (access) =>
            Result.map(decodeAssigneeCandidatesJson(raw), (candidates) => ({ access, candidates })),
          ),
      }).pipe(
        Effect.flatMap(({ access, candidates }) =>
          access.canTriage
            ? Effect.succeed(candidates)
            : Effect.fail(
                new GitHubIssueTriageRequiredError({ operation: "listAssigneeCandidates" }),
              ),
        ),
      );
    },

    listIssueTemplates: (input) => {
      const { owner, name } = parseRepositorySelector(input.repository);
      return Effect.all(
        [
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listIssueTemplates",
            variables: { owner, name },
            query: ISSUE_TEMPLATES_GRAPHQL_QUERY,
            decode: decodeIssueTemplatesJson,
          }),
          graphqlRead({
            cwd: input.cwd,
            host: input.host,
            operation: "listIssueTemplateForms",
            variables: { owner, name },
            query: ISSUE_TEMPLATE_FORMS_GRAPHQL_QUERY,
            decode: decodeIssueTemplateFormsJson,
          }).pipe(
            // A repository whose tree this account may not walk still has templates worth showing,
            // so the questions are lost rather than the chooser.
            Effect.catch((error) =>
              error._tag === "GitHubApiRateLimitError" ||
              error._tag === "SourceControlRateLimitPausedError"
                ? Effect.fail(error)
                : Effect.succeed({
                    forms: [] as ReadonlyArray<IssueTemplate>,
                    contributingGuidelinesUrl: undefined,
                  }),
            ),
          ),
          api
            .rest({
              host: input.host,
              operation: "listIssueTemplateConfig",
              accept: "application/vnd.github.raw",
              path: `repos/${owner}/${name}/contents/${TEMPLATE_CONFIG_PATH}`,
            })
            .pipe(
              Effect.map((response) => decodeIssueTemplateConfigYaml(response.body)),
              Effect.catch((error) =>
                error._tag === "GitHubApiRateLimitError" ||
                error._tag === "SourceControlRateLimitPausedError"
                  ? Effect.fail(error)
                  : Effect.succeed(DEFAULT_ISSUE_TEMPLATE_CONFIG),
              ),
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
