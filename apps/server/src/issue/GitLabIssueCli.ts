import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  IssueAction,
  IssueAssigneeCandidate,
  IssueAssigneeCandidateList,
  IssueComment,
  IssueEvent,
  IssueInvolvement,
  IssueLabelCandidateList,
  IssueLinkedPullRequest,
  IssueListState,
  IssueReaction,
  IssueReactionContent,
  IssueTemplate,
  IssueTemplateList,
} from "@t3tools/contracts";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import {
  decodeOwnGitLabAwardPageJson,
  gitLabAwardName,
} from "../sourceControl/gitLabReactionJson.ts";
import {
  decodeCreatedIssueJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssueNotesJson,
  decodeIssueAwardEmojiJson,
  decodeIssueTemplateEntriesJson,
  decodeIssueTemplateJson,
  decodeLabelEventsJson,
  decodeLinkedMergeRequestsJson,
  decodeProjectLabelsJson,
  decodeProjectMembersJson,
  decodeViewerJson,
  ISSUE_AWARD_EMOJI_GRAPHQL_QUERY,
  type GitLabIssue,
  type GitLabIssueDetail,
  type GitLabIssueTemplateEntry,
} from "./gitLabIssueJson.ts";
import type { ProviderListCursor } from "./IssueProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class GitLabIssueReadError extends Schema.TaggedErrorClass<GitLabIssueReadError>()(
  "GitLabIssueReadError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitLab CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

/** Not a decode failure: glab answered, the account it answered for just has no username. */
export class GitLabIssueViewerUnavailableError extends Schema.TaggedErrorClass<GitLabIssueViewerUnavailableError>()(
  "GitLabIssueViewerUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitLab CLI returned no username for the authenticated account.";
  }

  override get message(): string {
    return `GitLab CLI failed in getViewerUsername: ${this.detail}`;
  }
}

export type GitLabIssueCliError =
  | GitLabCli.GitLabCliError
  | GitLabIssueReadError
  | GitLabIssueViewerUnavailableError;

/** GitLab's own ceiling on `per_page`, so a larger page has to be walked. */
const MAX_PAGE_SIZE = 100;
/**
 * Pages of the conversation to follow before it is reported as truncated. GitLab caps a page at
 * a hundred, so this is a thousand notes — more than any issue a person is reading holds, and a
 * walk that ends whatever the host has.
 */
const CONVERSATION_PAGES = 10;
/**
 * Pages of merge request links to follow, per endpoint — five hundred of them, which no issue a
 * person opens has. The panel shows the links rather than counting them, so the bound is here to
 * end the walk rather than to be reached.
 */
const LINKED_PAGES = 5;

/**
 * Templates whose body is fetched, and how many of those reads run at once. Each one is a request
 * of its own, so a project that keeps dozens is cut short rather than spending a round trip apiece
 * on forms nobody scrolls to.
 */
const TEMPLATE_LIMIT = 25;
const TEMPLATE_CONCURRENCY = 4;

export interface GitLabIssueListBatch {
  readonly items: ReadonlyArray<GitLabIssue>;
  readonly truncated: boolean;
  /** Raw GitLab rows consumed to produce this page, including malformed rows. */
  readonly cursorAdvance: number;
}

export interface GitLabIssueActivity {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly truncated: boolean;
  readonly reactions: ReadonlyArray<IssueReaction>;
}

export class GitLabIssueCli extends Context.Service<
  GitLabIssueCli,
  {
    readonly getViewerUsername: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string, GitLabIssueCliError>;

    readonly listIssues: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Free text for GitLab's own `search`, which matches title and description. */
      readonly query?: string | undefined;
      /** Where to carry on from in GitLab's stable update-ordered row set. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<GitLabIssueListBatch, GitLabIssueCliError>;

    readonly getIssueDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitLabIssueDetail, GitLabIssueCliError>;

    /**
     * The merge requests GitLab reports against the issue. Two reads at once, because the ones
     * that close it and the ones that only mention it live behind different endpoints, and
     * neither answers for the other.
     */
    readonly listLinkedMergeRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, GitLabIssueCliError>;

    readonly listActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<GitLabIssueActivity, GitLabIssueCliError>;

    readonly createIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly title: string;
      readonly body: string;
      readonly labels: ReadonlyArray<string>;
      readonly assignees: ReadonlyArray<string>;
    }) => Effect.Effect<{ readonly number: number; readonly url: string }, GitLabIssueCliError>;

    readonly updateIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly runIssueAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly action: IssueAction;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly commentOnIssue: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly updateComment: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly setReaction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: IssueReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly setLabels: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly setAssignees: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
      /** GitLab's own numeric user ids, as the candidate list handed them out. */
      readonly assignees: ReadonlyArray<string>;
    }) => Effect.Effect<void, GitLabIssueCliError>;

    readonly listLabelCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<IssueLabelCandidateList, GitLabIssueCliError>;

    readonly listAssigneeCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<IssueAssigneeCandidateList, GitLabIssueCliError>;

    /**
     * The description templates this project offers, read in two steps because that is how GitLab
     * serves them: one endpoint names them, another carries each one's markdown.
     */
    readonly listIssueTemplates: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<IssueTemplateList, GitLabIssueCliError>;
  }
>()("t3/issue/GitLabIssueCli") {}

/** The REST API addresses a project by its URL-encoded full path. */
function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

function stateParam(state: IssueListState): string {
  // GitLab calls an open issue `opened`, and spans both states under `all`.
  return state === "open" ? "opened" : state;
}

function involvementParams(input: {
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  switch (input.involvement) {
    case "assigned":
      // An array parameter even for one name, which is how GitLab declares it.
      return [["assignee_username[]", input.viewer]];
    case "authored":
      return [["author_username", input.viewer]];
    // GitLab's project issue listing cannot express "mentioned" — its `scope` narrows to the
    // issues the viewer created or is assigned, which is a different question. The unnarrowed
    // page is answered rather than a filter that means something else, and nothing between here
    // and the reader narrows it back down: a `mentioned` listing is every issue in the project.
    case "mentioned":
    case "all":
      return [];
  }
}

function searchParams(search: string | undefined): ReadonlyArray<readonly [string, string]> {
  const trimmed = search?.trim() ?? "";
  return trimmed.length === 0 ? [] : [["search", trimmed]];
}

/**
 * Where a continuation carries on from, as the instant the last slice ended on and everything
 * before it. Without it the next request would offset into the list as it stands now, and an issue
 * touched between the two reads shifts every row past the boundary — sending some of them twice and
 * hiding others for good. GitLab's filter is inclusive, like the one every other host here is given:
 * rows sharing the boundary instant are ordinary, and the service drops the ones it has already sent
 * rather than asking for strictly older and losing their neighbours.
 */
function cursorParams(
  cursor: ProviderListCursor | undefined,
): ReadonlyArray<readonly [string, string]> {
  return cursor === undefined ? [] : [["updated_before", cursor.updatedBefore]];
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

/**
 * The ids GitLab would accept for an assignment. A candidate GitLab did not name is not an id it
 * would take, and sending it would write the assignee set around a number nobody chose.
 */
function assigneeIds(assignees: ReadonlyArray<string>): ReadonlyArray<number> {
  return assignees.flatMap((assignee) => {
    const id = Number(assignee);
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });
}

export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;

  const api = (input: {
    readonly cwd: string;
    readonly path: string;
    readonly method?: string;
    readonly stdin?: string;
  }) =>
    gitlab.execute({
      cwd: input.cwd,
      args: [
        "api",
        input.path,
        ...(input.method === undefined ? [] : ["--method", input.method]),
        // A raw body from stdin: argv is visible in process listings and is echoed back
        // inside process-runner failure messages. Unlike `gh`, `glab api --input` sends no
        // Content-Type at all, and GitLab answers a bodyless content type with HTTP 415.
        ...(input.stdin === undefined
          ? []
          : ["--input", "-", "--header", "Content-Type: application/json"]),
      ],
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    });

  const readError =
    (input: { readonly cwd: string; readonly operation: string }) => (cause: unknown) =>
      new GitLabIssueReadError({
        command: "glab",
        cwd: input.cwd,
        operation: input.operation,
        cause,
      });

  /**
   * `per_page` stops at 100, so a larger page is walked one request at a time. The walk is
   * bounded twice over: it stops on a short page or once the extra row that reveals a next
   * page has been read, and it never asks for more pages than the caller's page needs. The
   * second bound is what makes it terminate when every row on a page fails to decode, which
   * leaves nothing collected but does not mean GitLab has run out of rows.
   */
  const listPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: IssueListState;
    readonly involvement: IssueInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
    readonly page: number;
    readonly collected: ReadonlyArray<GitLabIssue>;
    readonly cursorAdvance: number;
  }): Effect.Effect<GitLabIssueListBatch, GitLabIssueCliError> => {
    const perPage = Math.min(input.limit + 1, MAX_PAGE_SIZE);
    // A page made entirely of malformed rows has no item from which the service can build a
    // continuation. Bound the walk to the raw span this request asked for rather than recursing
    // forever on a host that keeps returning full unusable pages.
    const lastPage = Math.floor(input.limit / perPage) + 1;
    return api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues?${query([
        ["state", stateParam(input.state)],
        ...involvementParams(input),
        // The listing is read through `glab api` rather than `glab issue list`, so the search is
        // the REST API's own `search` parameter. It matches title and description, and travels
        // URL-encoded like every other value here, so no text in it can become a parameter of
        // its own.
        ...searchParams(input.query),
        ...cursorParams(input.cursor),
        ["order_by", "updated_at"],
        ["sort", "desc"],
        ["per_page", String(perPage)],
        ["page", String(input.page)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const raw = result.stdout.trim();
        if (raw.length === 0) {
          return Effect.succeed({
            items: input.collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance,
          });
        }
        const decoded = decodeIssueListJson(raw);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "listIssues" })(decoded.failure),
          );
        }
        const remaining = input.limit - input.collected.length;
        const lastItemRawIndex = decoded.success.rawIndexes[remaining - 1];
        if (lastItemRawIndex !== undefined) {
          return Effect.succeed({
            items: [...input.collected, ...decoded.success.items.slice(0, remaining)],
            truncated:
              lastItemRawIndex + 1 < decoded.success.rawCount ||
              decoded.success.rawCount === perPage,
            cursorAdvance: input.cursorAdvance + lastItemRawIndex + 1,
          });
        }
        const collected = [...input.collected, ...decoded.success.items];
        const consumed = decoded.success.rawCount;
        // Counted before decoding, so a skipped malformed row cannot end paging early.
        const exhausted = decoded.success.rawCount < perPage;
        if (exhausted) {
          return Effect.succeed({
            items: collected,
            truncated: false,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        if (input.page >= lastPage) {
          return Effect.succeed({
            items: collected,
            truncated: true,
            cursorAdvance: input.cursorAdvance + consumed,
          });
        }
        return listPage({
          ...input,
          page: input.page + 1,
          collected,
          cursorAdvance: input.cursorAdvance + consumed,
        });
      }),
    );
  };

  const issueDetail = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
  }): Effect.Effect<GitLabIssueDetail, GitLabIssueCliError> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${input.number}`,
    }).pipe(
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
   * The conversation, a page at a time. GitLab pages by offset and reports no total, so a short
   * page is the only thing that says it is done — and the raw count decides, not the kept one:
   * the notes GitLab wrote itself become events rather than comments, and a whole page of them
   * still means there is more to read.
   */
  const notesPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly comments: ReadonlyArray<IssueComment>;
    readonly events: ReadonlyArray<IssueEvent>;
  }): Effect.Effect<
    {
      readonly comments: ReadonlyArray<IssueComment>;
      readonly events: ReadonlyArray<IssueEvent>;
      readonly truncated: boolean;
    },
    GitLabIssueCliError
  > =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${input.number}/notes?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ["page", String(input.page)],
        ["order_by", "created_at"],
        ["sort", "asc"],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeIssueNotesJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "listActivity" })(decoded.failure),
          );
        }
        const comments = [...input.comments, ...decoded.success.comments];
        const events = [...input.events, ...decoded.success.events];
        if (decoded.success.rawCount < MAX_PAGE_SIZE) {
          return Effect.succeed({ comments, events, truncated: false });
        }
        return input.page >= CONVERSATION_PAGES
          ? Effect.succeed({ comments, events, truncated: true })
          : notesPage({ ...input, page: input.page + 1, comments, events });
      }),
    );

  /**
   * The labellings, walked the same way and stopped by the same bound — and reporting that bound
   * the same way too: an issue relabelled more often than the walk follows has a history as
   * incomplete as one talked over more than the walk reads.
   */
  const labelEventsPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly page: number;
    readonly collected: ReadonlyArray<IssueEvent>;
  }): Effect.Effect<
    { readonly events: ReadonlyArray<IssueEvent>; readonly truncated: boolean },
    GitLabIssueCliError
  > =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${
        input.number
      }/resource_label_events?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ["page", String(input.page)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeLabelEventsJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "listActivity" })(decoded.failure),
          );
        }
        const collected = [...input.collected, ...decoded.success.events];
        if (decoded.success.rawCount < MAX_PAGE_SIZE) {
          return Effect.succeed({ events: collected, truncated: false });
        }
        return input.page >= CONVERSATION_PAGES
          ? Effect.succeed({ events: collected, truncated: true })
          : labelEventsPage({ ...input, page: input.page + 1, collected });
      }),
    );

  /**
   * One endpoint's links, a page at a time. Both endpoints page by offset like the rest of GitLab,
   * so a single page would drop every link past the first hundred on an issue a whole release
   * branched off. The walk is bounded like the conversation's: a short page ends it, and
   * `LINKED_PAGES` ends it anyway.
   */
  const linkedMergeRequests = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly endpoint: "closed_by" | "related_merge_requests";
    readonly page: number;
    readonly collected: ReadonlyArray<IssueLinkedPullRequest>;
  }): Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, GitLabIssueCliError> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${input.number}/${
        input.endpoint
      }?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ["page", String(input.page)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeLinkedMergeRequestsJson(
          result.stdout.trim(),
          input.endpoint === "closed_by",
        );
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "listLinkedMergeRequests" })(decoded.failure),
          );
        }
        const collected = [...input.collected, ...decoded.success.links];
        return decoded.success.rawCount < MAX_PAGE_SIZE || input.page >= LINKED_PAGES
          ? Effect.succeed(collected)
          : linkedMergeRequests({ ...input, page: input.page + 1, collected });
      }),
    );

  const projectLabels = (input: { readonly cwd: string; readonly repository: string }) =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/labels?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeProjectLabelsJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              readError({ cwd: input.cwd, operation: "listLabelCandidates" })(decoded.failure),
            );
      }),
    );

  const projectMembers = (input: { readonly cwd: string; readonly repository: string }) =>
    api({
      cwd: input.cwd,
      // `members/all` rather than `members`, so the people a parent group lends the project are
      // offered too — GitLab lets every one of them be assigned an issue.
      path: `projects/${projectPath(input.repository)}/members/all?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeProjectMembersJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              readError({ cwd: input.cwd, operation: "listAssigneeCandidates" })(decoded.failure),
            );
      }),
    );

  /**
   * One template's own body, as its own request. A template whose body cannot be read is dropped
   * rather than offered empty: choosing it would open a form with nothing of the template in it.
   */
  const templateContent = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly entry: GitLabIssueTemplateEntry;
  }): Effect.Effect<ReadonlyArray<IssueTemplate>, never> =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/templates/issues/${encodeURIComponent(input.entry.key)}`,
    }).pipe(
      Effect.map((result) => {
        const content = decodeIssueTemplateJson(result.stdout.trim());
        return Result.isSuccess(content)
          ? [
              {
                key: input.entry.key,
                name: input.entry.name,
                // A GitLab template is a description and nothing else: no summary of its own, no
                // title, no labels and no assignees to carry.
                about: "",
                title: "",
                body: content.success,
                labels: [],
                assignees: [],
              } satisfies IssueTemplate,
            ]
          : [];
      }),
      Effect.orElseSucceed((): ReadonlyArray<IssueTemplate> => []),
    );

  /** Every write to an issue is the same PUT, so its body is the only thing that differs. */
  const updateIssue = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly body: Record<string, unknown>;
  }) =>
    api({
      cwd: input.cwd,
      path: `projects/${projectPath(input.repository)}/issues/${input.number}`,
      method: "PUT",
      // A JSON body rather than a `--raw-field`: glab coerces a field that reads as a literal
      // `true` or a number, and a title or a description is text either way.
      stdin: JSON.stringify(input.body),
    }).pipe(Effect.asVoid);

  const viewerUsername = (input: { readonly cwd: string }) =>
    api({ cwd: input.cwd, path: "user" }).pipe(
      Effect.flatMap((result): Effect.Effect<string, GitLabIssueCliError> => {
        const decoded = decodeViewerJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "getViewerUsername" })(decoded.failure),
          );
        }
        return decoded.success === null
          ? Effect.fail(new GitLabIssueViewerUnavailableError({ command: "glab", cwd: input.cwd }))
          : Effect.succeed(decoded.success);
      }),
    );

  const awardSubjectPath = (input: {
    readonly repository: string;
    readonly number: number;
    readonly subjectId?: string | undefined;
  }) => {
    const issue = `projects/${projectPath(input.repository)}/issues/${input.number}`;
    return input.subjectId === undefined
      ? `${issue}/award_emoji`
      : `${issue}/notes/${encodeURIComponent(input.subjectId)}/award_emoji`;
  };

  const ownAwardId = (input: {
    readonly cwd: string;
    readonly subject: string;
    readonly content: IssueReactionContent;
    readonly viewer: string;
    readonly page: number;
  }): Effect.Effect<number | null, GitLabIssueCliError> =>
    api({
      cwd: input.cwd,
      path:
        input.subject +
        "?" +
        query([
          ["per_page", String(MAX_PAGE_SIZE)],
          ["page", String(input.page)],
        ]),
    }).pipe(
      Effect.flatMap((listed) => {
        const decoded = decodeOwnGitLabAwardPageJson(listed.stdout.trim(), input);
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "setReaction" })(decoded.failure),
          );
        }
        return decoded.success.id !== null || decoded.success.rawCount < MAX_PAGE_SIZE
          ? Effect.succeed(decoded.success.id)
          : ownAwardId({ ...input, page: input.page + 1 });
      }),
    );

  const awardsPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly number: number;
    readonly cursor: string | null;
    readonly page: number;
    readonly collected: Map<string, ReadonlyArray<IssueReaction>>;
  }): Effect.Effect<
    {
      readonly reactions: ReadonlyArray<IssueReaction>;
      readonly reactionsByNoteId: ReadonlyMap<string, ReadonlyArray<IssueReaction>>;
    },
    GitLabIssueCliError
  > =>
    api({
      cwd: input.cwd,
      path: "graphql",
      method: "POST",
      stdin: JSON.stringify({
        query: ISSUE_AWARD_EMOJI_GRAPHQL_QUERY,
        variables: { fullPath: input.repository, iid: String(input.number), cursor: input.cursor },
      }),
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeIssueAwardEmojiJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            readError({ cwd: input.cwd, operation: "listActivity" })(decoded.failure),
          );
        }
        for (const [id, reactions] of decoded.success.reactionsByNoteId) {
          input.collected.set(id, reactions);
        }
        return decoded.success.nextCursor === null || input.page >= CONVERSATION_PAGES
          ? Effect.succeed({
              reactions: decoded.success.reactions,
              reactionsByNoteId: input.collected,
            })
          : awardsPage({
              ...input,
              cursor: decoded.success.nextCursor,
              page: input.page + 1,
            });
      }),
    );

  return GitLabIssueCli.of({
    getViewerUsername: viewerUsername,

    // Every read starts at the first page: a continuation is the boundary instant, not an offset
    // into a list that moves under it.
    listIssues: (input) => listPage({ ...input, page: 1, collected: [], cursorAdvance: 0 }),

    getIssueDetail: issueDetail,

    listLinkedMergeRequests: (input) =>
      Effect.all(
        [
          linkedMergeRequests({ ...input, endpoint: "closed_by", page: 1, collected: [] }),
          linkedMergeRequests({
            ...input,
            endpoint: "related_merge_requests",
            page: 1,
            collected: [],
          }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([closing, related]) => {
          // The two endpoints overlap: a merge request that closes the issue also mentions it.
          // The closing answer wins, so the stronger of the two relationships is the one shown.
          // One pass over both, so a link a paged endpoint repeats is dropped as well.
          const seen = new Set<string>();
          return [...closing, ...related].filter((link) => {
            const key = `${link.repository}!${link.number}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }),
      ),

    listActivity: (input) =>
      Effect.all(
        [
          notesPage({ ...input, page: 1, comments: [], events: [] }),
          labelEventsPage({ ...input, page: 1, collected: [] }),
          awardsPage({ ...input, cursor: null, page: 1, collected: new Map() }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([notes, labelEvents, awards]) => ({
          comments: notes.comments.map((comment) => ({
            ...comment,
            reactions: awards.reactionsByNoteId.get(comment.id) ?? [],
          })),
          // Two reads, so the merged history is ordered here rather than left interleaved by
          // whichever of them answered first.
          events: [...notes.events, ...labelEvents.events].sort((left, right) =>
            left.createdAt === right.createdAt ? 0 : left.createdAt < right.createdAt ? -1 : 1,
          ),
          // Either walk hitting its bound leaves the timeline short, and a history missing its
          // labellings is no more complete than one missing its remarks.
          truncated: notes.truncated || labelEvents.truncated,
          reactions: awards.reactions,
        })),
      ),

    createIssue: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/issues`,
        method: "POST",
        stdin: JSON.stringify({
          title: input.title,
          description: input.body,
          labels: [...input.labels],
          assignee_ids: assigneeIds(input.assignees),
        }),
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeCreatedIssueJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(readError({ cwd: input.cwd, operation: "createIssue" })(decoded.failure));
        }),
      ),

    updateIssue: (input) =>
      updateIssue({
        ...input,
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { description: input.body }),
        },
      }),

    // The same PUT the edit uses: `glab issue close` would do it too, but a state change is one
    // field of the issue, and one path through GitLab is one thing to get right.
    runIssueAction: (input) =>
      updateIssue({
        ...input,
        body: { state_event: input.action === "close" ? "close" : "reopen" },
      }),

    commentOnIssue: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/issues/${input.number}/notes`,
        method: "POST",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid),

    updateComment: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/issues/${input.number}/notes/${encodeURIComponent(input.commentId)}`,
        method: "PUT",
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid),

    setReaction: (input) =>
      Effect.gen(function* () {
        const subject = awardSubjectPath(input);
        if (input.reacted) {
          yield* api({
            cwd: input.cwd,
            path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
            method: "POST",
          });
          return;
        }
        const viewer = yield* viewerUsername({ cwd: input.cwd });
        const own = yield* ownAwardId({
          cwd: input.cwd,
          subject,
          content: input.content,
          viewer,
          page: 1,
        });
        if (own === null) return;
        yield* api({ cwd: input.cwd, path: subject + "/" + own, method: "DELETE" });
      }),

    setLabels: (input) =>
      updateIssue({
        ...input,
        // An array, which no label name can break; GitLab documents the empty string, and only
        // the empty string, as the way to take every label off an issue.
        body: { labels: input.labels.length === 0 ? "" : [...input.labels] },
      }),

    setAssignees: (input) =>
      // The whole set rather than a change to it, which is what GitLab writes here anyway: an
      // empty list unassigns everybody.
      updateIssue({ ...input, body: { assignee_ids: assigneeIds(input.assignees) } }),

    listLabelCandidates: (input) =>
      Effect.all([issueDetail(input), projectLabels(input)], { concurrency: 2 }).pipe(
        Effect.map(([issue, labels]) => {
          const applied = new Set(issue.labels.map((label) => label.name));
          return {
            candidates: labels.labels.map((label) => ({
              ...label,
              isApplied: applied.has(label.name),
            })),
            truncated: labels.rawCount >= MAX_PAGE_SIZE,
          };
        }),
      ),

    listAssigneeCandidates: (input) =>
      Effect.all([issueDetail(input), projectMembers(input)], { concurrency: 2 }).pipe(
        Effect.map(([issue, members]) => {
          // Whoever already has the issue leads the list, ahead of the member page and whatever
          // that page left out. The set is written whole and can only be spelled from here, so an
          // assignee the members walk never reached would come off the issue on the next write —
          // silently, and off somebody the reader was never shown.
          const candidates = new Map<string, IssueAssigneeCandidate>();
          for (const assignee of issue.assigneeCandidates) {
            candidates.set(assignee.login, { ...assignee, isAssigned: true });
          }
          for (const member of members.members) {
            if (candidates.has(member.login)) continue;
            candidates.set(member.login, { ...member, isAssigned: false });
          }
          return {
            candidates: [...candidates.values()],
            truncated: members.rawCount >= MAX_PAGE_SIZE,
          };
        }),
      ),

    listIssueTemplates: (input) =>
      api({
        cwd: input.cwd,
        path: `projects/${projectPath(input.repository)}/templates/issues`,
      }).pipe(
        Effect.flatMap(
          (result): Effect.Effect<ReadonlyArray<IssueTemplate>, GitLabIssueCliError> => {
            const decoded = decodeIssueTemplateEntriesJson(result.stdout.trim());
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                readError({ cwd: input.cwd, operation: "listIssueTemplates" })(decoded.failure),
              );
            }
            return Effect.forEach(
              decoded.success.slice(0, TEMPLATE_LIMIT),
              (entry) => templateContent({ cwd: input.cwd, repository: input.repository, entry }),
              { concurrency: TEMPLATE_CONCURRENCY },
            ).pipe(Effect.map((templates) => templates.flat()));
          },
        ),
        // GitLab keeps no contact links, and never asks that an issue be filed from a template.
        Effect.map((templates) => ({ templates, contactLinks: [], blankIssuesEnabled: true })),
      ),
  });
});

export const layer = Layer.effect(GitLabIssueCli, make);
