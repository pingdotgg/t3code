/**
 * GitCafe's issues over its REST API, read-only. GitCafe pages issues by an opaque `next` token,
 * handed out as the cursor unchanged, and filters labels by id, so names are resolved first.
 * Comments only page forward from the oldest, so the detail walks to the newest page and its
 * cursor carries the start of every earlier page to step back through.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  IssueTrackerKind,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueCapabilities,
  type IssueComment,
  type IssueState,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueScopeTarget,
  type IssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as GitCafeApi from "./GitCafeApi.ts";
import * as GitCafeHosts from "./gitCafeHosts.ts";
import * as Json from "./gitCafePullRequestJson.ts";

const KIND = IssueTrackerKind.make("gitcafe");

const CAPABILITIES: IssueCapabilities = {
  create: false,
  edit: false,
  comment: false,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

const READ_ONLY: IssueViewerPermissions = {
  setState: false,
  comment: false,
  edit: false,
  labels: false,
  assignees: false,
};

/** GitCafe's ceiling on a page of issues, comments or labels. */
const PAGE_SIZE = 100;
const MAX_LABEL_PAGES = 10;
/** The walk to the newest comment stops here, at 3,000 comments. */
const MAX_COMMENT_PAGES = 30;
const CURSOR = /^[A-Za-z0-9_-]{1,8192}$/u;
/** `o` then `.<start>` for every page after the first up to the one it reads, oldest first. */
const COMMENTS_CURSOR = /^o(?:\.[A-Za-z0-9_-]+)*$/u;
const MAX_COMMENTS_CURSOR_LENGTH = 4_096;

const STATES: Readonly<Record<string, IssueState>> = {
  triage: { category: "open", name: "Triage" },
  backlog: { category: "open", name: "Backlog" },
  unstarted: { category: "open", name: "Unstarted" },
  started: { category: "open", name: "Started" },
  completed: { category: "closed", name: "Completed", closeReason: "completed" },
  canceled: { category: "closed", name: "Canceled", closeReason: "canceled" },
};

const Issue = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  stateType: TrimmedNonEmptyString,
  author: Json.Actor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  labels: Schema.Array(
    Schema.Struct({ name: TrimmedNonEmptyString, color: Schema.NullOr(Schema.String) }),
  ),
  assignees: Schema.Array(Schema.Struct({ actor: Json.Actor })),
});
type Issue = typeof Issue.Type;

const IssuePage = Schema.Struct({ items: Schema.Array(Issue), next: Schema.NullOr(Schema.String) });

const CommentPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      author: Json.Actor,
      body: Schema.String,
      createdAt: IsoDateTime,
    }),
  ),
  next: Schema.NullOr(Schema.String),
});

const Principal = Schema.Struct({ actorId: TrimmedNonEmptyString, handle: TrimmedNonEmptyString });

function issueState(issue: Issue): IssueState {
  return (
    STATES[issue.stateType] ?? {
      category: issue.closedAt === null ? "open" : "closed",
      name: issue.stateType,
    }
  );
}

function toSummary(issue: Issue, target: IssueScopeTarget): TrackerIssueSummary {
  return {
    key: String(issue.number),
    displayKey: `#${issue.number}`,
    title: issue.title,
    url: `https://${target.host}/${target.scope}/issues/${issue.number}`,
    author: Json.toActor(issue.author, target.host),
    state: issueState(issue),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    assignees: issue.assignees.flatMap(({ actor }) => Json.toActor(actor, target.host) ?? []),
    labels: issue.labels.map(({ name, color }) => ({ name, color })),
    // Listings carry no comment count; the detail counts what it reads.
    commentCount: 0,
  };
}

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const EMPTY_PAGE = { items: [], nextCursor: null };

/** The cursor that reads the page starting at the last of `starts`, or the first page when none. */
const commentsCursor = (starts: ReadonlyArray<string>) => ["o", ...starts].join(".");

function parseCommentsCursor(cursor: string): ReadonlyArray<string> | null {
  if (cursor.length > MAX_COMMENTS_CURSOR_LENGTH || !COMMENTS_CURSOR.test(cursor)) return null;
  const starts = cursor.split(".").slice(1);
  return starts.length < MAX_COMMENT_PAGES ? starts : null;
}

export const make: Effect.Effect<IssueTrackerApi, never, GitCafeApi.GitCafeApi> = Effect.gen(
  function* () {
    const api = yield* GitCafeApi.GitCafeApi;

    const failure = (
      operation: string,
      reason: IssueTrackerError["reason"],
      detail: string,
      cause?: unknown,
    ) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

    const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
      operation: string,
      host: string,
      path: string,
      schema: S,
    ): Effect.Effect<S["Type"], IssueTrackerError> =>
      api.request({ host, operation, path }).pipe(
        Effect.mapError((error) => failure(operation, error.reason, error.detail, error)),
        Effect.flatMap((raw) =>
          Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
            Effect.mapError((cause) =>
              failure(operation, "failed", "GitCafe returned an unreadable response.", cause),
            ),
          ),
        ),
      );

    const repositoryPath = (
      operation: string,
      target: IssueScopeTarget,
    ): Effect.Effect<string, IssueTrackerError> =>
      GitCafeHosts.isGitCafeHost(target.host) &&
      GitCafeHosts.gitCafeRepositoryPath(target.scope) === target.scope
        ? Effect.succeed(`/repos/${target.scope}`)
        : Effect.fail(
            failure(
              operation,
              "failed",
              `GitCafe serves owner/name repositories on ${GitCafeHosts.GITCAFE_HOSTS.join(" and ")}.`,
            ),
          );

    const issuePath = (
      operation: string,
      target: IssueScopeTarget & { readonly key: string },
    ): Effect.Effect<string, IssueTrackerError> =>
      /^[1-9]\d{0,9}$/u.test(target.key)
        ? repositoryPath(operation, target).pipe(
            Effect.map((base) => `${base}/issues/${target.key}`),
          )
        : Effect.fail(failure(operation, "not-found", "GitCafe could not find the issue."));

    const checkCursor = (operation: string, cursor: string) =>
      CURSOR.test(cursor)
        ? Effect.void
        : Effect.fail(failure(operation, "failed", "The cursor was not one GitCafe handed out."));

    const principal = (operation: string, host: string) =>
      read(operation, host, "/auth/principal", Principal);

    const readCommentPage = (
      operation: string,
      target: IssueScopeTarget,
      path: string,
      after: string | null,
    ) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (after !== null) query.set("after", after);
      return read(operation, target.host, `${path}/comments/?${query}`, CommentPage).pipe(
        Effect.map((page) => ({
          comments: page.items.map((comment): IssueComment => ({
            id: comment.id,
            author: Json.toActor(comment.author, target.host),
            body: comment.body,
            createdAt: comment.createdAt,
            url: null,
          })),
          next: page.next,
        })),
      );
    };

    /**
     * The newest page of comments, found by walking from the oldest with only the latest page
     * kept, and the cursor back to the page before it.
     */
    const newestComments = Effect.fn("GitCafeIssueTracker.newestComments")(function* (
      target: IssueScopeTarget,
      path: string,
    ) {
      // `starts[i]` is the token that reads page i + 1; the first page needs none.
      const starts: Array<string> = [];
      let newest: { readonly comments: ReadonlyArray<IssueComment>; readonly index: number } = {
        comments: [],
        index: 0,
      };
      let count = 0;
      for (let index = 0; ; index++) {
        const page = yield* readCommentPage(
          "getIssue",
          target,
          path,
          index === 0 ? null : starts[index - 1]!,
        );
        count += page.comments.length;
        if (page.comments.length > 0 || index === 0) newest = { comments: page.comments, index };
        if (page.next === null) break;
        if (!CURSOR.test(page.next) || starts.includes(page.next)) {
          return yield* failure("getIssue", "failed", "GitCafe repeated a page of comments.");
        }
        if (index + 1 >= MAX_COMMENT_PAGES) {
          return yield* failure(
            "getIssue",
            "failed",
            `GitCafe issues with more than ${MAX_COMMENT_PAGES * PAGE_SIZE} comments cannot be read here.`,
          );
        }
        starts.push(page.next);
      }
      const back = newest.index === 0 ? null : commentsCursor(starts.slice(0, newest.index - 1));
      if (back !== null && back.length > MAX_COMMENTS_CURSOR_LENGTH) {
        return yield* failure(
          "getIssue",
          "failed",
          "GitCafe's comment cursors are too long to page back through.",
        );
      }
      return { comments: newest.comments, count, commentsCursor: back };
    });

    /** The id of every label named, or none when the repository lacks one of them. */
    const labelIds = Effect.fn("GitCafeIssueTracker.labelIds")(function* (
      target: IssueScopeTarget,
      base: string,
      names: ReadonlyArray<string>,
    ) {
      const ids = new Map<string, string>();
      let after: string | null = null;
      for (let page = 0; page < MAX_LABEL_PAGES; page++) {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (after !== null) query.set("after", after);
        const labels: typeof Json.GitCafeLabels.Type = yield* read(
          "listIssues",
          target.host,
          `${base}/labels?${query}`,
          Json.GitCafeLabels,
        );
        for (const label of labels.items) {
          const name = names.find((wanted) => sameName(wanted, label.name));
          if (name !== undefined) ids.set(name.toLowerCase(), label.id);
        }
        if (labels.next === null || labels.next === after || ids.size === names.length) break;
        after = labels.next;
      }
      return names.every((name) => ids.has(name.toLowerCase()))
        ? Option.some(names.map((name) => ids.get(name.toLowerCase())!))
        : Option.none();
    });

    return {
      kind: KIND,
      capabilities: CAPABILITIES,

      getViewer: (input) =>
        principal("getViewer", input.host).pipe(Effect.map((viewer) => viewer.handle)),

      listIssues: Effect.fn("GitCafeIssueTracker.listIssues")(function* (input) {
        if (input.cursor !== undefined) yield* checkCursor("listIssues", input.cursor);
        // GitCafe cannot tell who an issue mentions, so that listing has nothing it could show.
        if (input.involvement === "mentioned") return EMPTY_PAGE;
        const base = yield* repositoryPath("listIssues", input);
        const query = new URLSearchParams({
          limit: String(Math.min(PAGE_SIZE, Math.max(1, input.limit))),
          sort: input.sort,
          direction: "desc",
        });
        if (input.state !== "all") query.set("statuses", input.state);
        const text = input.query?.trim() ?? "";
        if (text.length > 0) query.set("q", text);

        if (input.involvement !== "all") {
          const viewer = yield* principal("listIssues", input.host);
          query.set(input.involvement === "authored" ? "author" : "assignee", viewer.actorId);
        }
        const labels = input.labels ?? [];
        if (labels.length > 0) {
          const ids = yield* labelIds(input, base, labels);
          if (Option.isNone(ids)) return EMPTY_PAGE;
          // Several labels match an issue carrying any of them, so one narrows and every one is
          // checked on the rows.
          query.set("labels", ids.value[0]!);
        }
        if (input.cursor !== undefined) query.set("after", input.cursor);

        const page = yield* read("listIssues", input.host, `${base}/issues/?${query}`, IssuePage);
        // GitCafe filters assignees by actor id, and no complete route turns a login into every
        // actor shown under it, so the login is matched on the rows. A page may come back empty
        // with a cursor still to follow.
        const assignee = input.assignee ?? null;
        return {
          items: page.items
            .map((issue) => toSummary(issue, input))
            .filter(
              (issue) =>
                labels.every((name) => issue.labels.some((label) => sameName(label.name, name))) &&
                (assignee === null ||
                  issue.assignees.some((actor) => sameName(actor.login, assignee))),
            ),
          nextCursor: page.items.length === 0 || page.next === input.cursor ? null : page.next,
        };
      }),

      getIssue: Effect.fn("GitCafeIssueTracker.getIssue")(function* (input) {
        const path = yield* issuePath("getIssue", input);
        // A refused or unreadable conversation leaves the issue itself readable.
        const comments = newestComments(input, path).pipe(
          Effect.asSome,
          Effect.catch((error) =>
            Effect.logWarning("GitCafe issue comments could not be read", {
              reason: error.reason,
            }).pipe(Effect.as(Option.none())),
          ),
        );
        const [issue, conversation] = yield* Effect.all(
          [read("getIssue", input.host, path, Issue), comments],
          { concurrency: 2 },
        );
        return {
          ...toSummary(issue, input),
          commentCount: Option.isSome(conversation) ? conversation.value.count : 0,
          body: issue.description ?? "",
          viewer: null,
          viewerPermissions: READ_ONLY,
          // Empty: nothing here moves an issue between states.
          states: [],
          ...(Option.isSome(conversation)
            ? {
                comments: conversation.value.comments,
                commentsCursor: conversation.value.commentsCursor,
              }
            : { comments: [], commentsCursor: null, commentsUnavailable: true }),
          events: [],
          linkedPullRequests: [],
        };
      }),

      getComments: Effect.fn("GitCafeIssueTracker.getComments")(function* (input) {
        const starts = parseCommentsCursor(input.cursor);
        if (starts === null) {
          return yield* failure(
            "getComments",
            "failed",
            "The cursor was not one GitCafe handed out.",
          );
        }
        const path = yield* issuePath("getComments", input);
        const page = yield* readCommentPage("getComments", input, path, starts.at(-1) ?? null);
        return {
          comments: page.comments,
          nextCursor: starts.length === 0 ? null : commentsCursor(starts.slice(0, -1)),
        };
      }),
    };
  },
);
