/**
 * GitLab's issue tracker over `glab api`. GitLab pages by offset and reports no total, so every
 * cursor is a page number and a full page is the only sign that more exists. Notes, label
 * events, linked merge requests and awards are separate endpoints, joined into the detail.
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueInvolvement,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as GitLabCli from "./GitLabCli.ts";
import {
  decodeCreatedIssueJson,
  decodeUserIdsJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssueNotesJson,
  decodeLabelEventsJson,
  decodeLinkedMergeRequestsJson,
  decodeProjectLabelsJson,
  decodeProjectMembersJson,
  decodeTemplateEntriesJson,
  decodeTemplateJson,
  ISSUE_AWARD_EMOJI_GRAPHQL_QUERY,
  PAGE_SIZE,
  type GitLabTemplateEntry,
} from "./gitLabIssueJson.ts";
import {
  decodeAwardEmojiJson,
  decodeOwnAwardIdJson,
  decodeViewerJson,
  gitLabAwardName,
} from "./gitLabMergeRequestJson.ts";

const KIND = IssueTrackerKind.make("gitlab");

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
  states: [
    { category: "open", name: "open" },
    { category: "closed", name: "closed" },
  ],
  // GitLab records nothing about why an issue was closed.
  closeReasons: [],
};

/**
 * Everything granted. GitLab's REST API reports the viewer's role on the project but never whether
 * they opened this issue, and an issue's author may close, reopen and edit it whatever their role.
 * Withholding those controls from the one person entitled to them is the worse mistake, so they
 * are offered and GitLab explains any refusal itself.
 */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

/** How many of a scope's templates are read in full; each one is a request of its own. */
const TEMPLATE_LIMIT = 20;

const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The REST API addresses a project by its URL-encoded full path. */
function projectPath(scope: string): string {
  return encodeURIComponent(scope.trim());
}

/** An issue key is its iid; anything else names no GitLab issue. */
function parseNumber(key: string): number | null {
  return /^[1-9]\d*$/.test(key) ? Number(key) : null;
}

/** A page cursor this tracker handed out, or null for anything it could not have issued. */
function parsePage(cursor: string | undefined): number | null {
  if (cursor === undefined) return 1;
  return /^[1-9]\d{0,6}$/.test(cursor) ? Number(cursor) : null;
}

/**
 * A comments cursor: the next REST page of notes and, after a colon, where GraphQL's awards for
 * that page start. The two page alike, so a page of comments is joined with its own awards.
 */
function parseCommentsCursor(
  cursor: string,
): { readonly page: number; readonly awards: string | null } | null {
  const match = /^([1-9]\d{0,6})(?::(.{1,512}))?$/.exec(cursor);
  return match === null ? null : { page: Number(match[1]), awards: match[2] ?? null };
}

function commentsCursor(notesNext: string | null, awardsNext: string | null): string | null {
  if (notesNext === null) return null;
  return awardsNext === null ? notesNext : `${notesNext}:${awardsNext}`;
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function involvementParams(input: {
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
  readonly assignee?: string | undefined;
}): ReadonlyArray<readonly [string, string]> {
  switch (input.involvement) {
    case "authored":
      return [["author_username", input.viewer]];
    case "assigned":
      // A named assignee takes the one assignee parameter GitLab reads; `listIssues` keeps the
      // viewer by dropping rows.
      return input.assignee === undefined ? [["assignee_username", input.viewer]] : [];
    // GitLab's `my_reaction_emoji` and `iteration` filters aside, nothing narrows to mentions, so
    // the listing stays as wide as `all` rather than guessing.
    case "mentioned":
    case "all":
      return [];
  }
}

function reasonFor(error: GitLabCli.GitLabCliError): IssueTrackerError["reason"] {
  switch (error._tag) {
    case "GitLabCliUnavailableError":
      return "missing-tool";
    case "GitLabCliAuthenticationError":
      return "unauthenticated";
    case "GitLabCliRateLimitError":
      return "rate-limited";
    default:
      return "failed";
  }
}

export const make: Effect.Effect<IssueTrackerApi, never, GitLabCli.GitLabCli> = Effect.gen(
  function* () {
    const gitlab = yield* GitLabCli.GitLabCli;

    const fail = (operation: string) => (error: GitLabCli.GitLabCliError) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: reasonFor(error),
        detail: error.detail,
        cause: error,
      });

    const unreadable = (operation: string, cause: unknown) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "failed",
        detail: `GitLab returned an unreadable ${operation} response.`,
        cause,
      });

    const notFound = (operation: string) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "not-found",
        detail: "GitLab could not find the requested issue.",
      });

    const refused = (operation: string, detail: string) =>
      new IssueTrackerError({ tracker: KIND, operation, reason: "failed", detail });

    const api = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
      readonly path: string;
      readonly method?: string;
      readonly body?: unknown;
    }) =>
      gitlab
        .execute({
          cwd: input.cwd,
          host: input.host,
          args: [
            "api",
            input.path,
            ...(input.method === undefined ? [] : ["--method", input.method]),
            // A JSON body from stdin: argv is visible in process listings, and `glab api --input`
            // sends no Content-Type of its own, which GitLab answers with HTTP 415.
            ...(input.body === undefined
              ? []
              : ["--input", "-", "--header", "Content-Type: application/json"]),
          ],
          ...(input.body === undefined ? {} : { stdin: encodeBody(input.body) }),
        })
        .pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.mapError(fail(input.operation)),
        );

    const read = <A>(input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
      readonly path: string;
      readonly method?: string;
      readonly body?: unknown;
      readonly decode: (raw: string) => Result.Result<A, unknown>;
    }): Effect.Effect<A, IssueTrackerError> =>
      api(input).pipe(
        Effect.flatMap((raw) => {
          const decoded = input.decode(raw);
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(unreadable(input.operation, decoded.failure));
        }),
      );

    const write = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
      readonly path: string;
      readonly method: string;
      readonly body?: unknown;
    }) => api(input).pipe(Effect.asVoid);

    /** The signed-in account; an answer naming nobody is a failure, since every comparison needs a login. */
    const viewer = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
    }): Effect.Effect<string, IssueTrackerError> =>
      read({
        cwd: input.cwd,
        host: input.host,
        operation: input.operation,
        path: "user",
        decode: decodeViewerJson,
      }).pipe(
        Effect.filterOrFail(
          (login) => login !== null,
          () => refused(input.operation, "GitLab returned no username for the signed-in account."),
        ),
      );

    /** The issue as REST addresses it, or a not-found for a key that names no iid. */
    const issuePath = (
      input: { readonly scope: string; readonly key: string },
      operation: string,
    ): Effect.Effect<{ readonly number: number; readonly path: string }, IssueTrackerError> => {
      const number = parseNumber(input.key);
      return number === null
        ? Effect.fail(notFound(operation))
        : Effect.succeed({ number, path: `projects/${projectPath(input.scope)}/issues/${number}` });
    };

    /**
     * GitLab writes assignees by numeric id, which is what the candidates carry as `id`. An issue
     * names the people it already has by username, so a kept assignee is looked up.
     */
    const assigneeIds = (
      input: { readonly cwd: string; readonly host: string },
      operation: string,
      assignees: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<number>, IssueTrackerError> =>
      Effect.forEach(assignees, (assignee) =>
        /^[1-9]\d*$/.test(assignee)
          ? Effect.succeed(Number(assignee))
          : read({
              cwd: input.cwd,
              host: input.host,
              operation,
              path: `users?${query([["username", assignee]])}`,
              decode: decodeUserIdsJson,
            }).pipe(
              Effect.flatMap(([id]) =>
                id === undefined
                  ? Effect.fail(refused(operation, `GitLab has no user named ${assignee}.`))
                  : Effect.succeed(id),
              ),
            ),
      );

    const paged = (path: string, page: number) =>
      `${path}?${query([
        ["per_page", String(PAGE_SIZE)],
        ["page", String(page)],
      ])}`;

    const notesPage = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly path: string;
      readonly page: number;
      readonly operation: string;
    }) =>
      read({
        cwd: input.cwd,
        host: input.host,
        operation: input.operation,
        path: `${input.path}/notes?${query([
          ["per_page", String(PAGE_SIZE)],
          ["page", String(input.page)],
          ["order_by", "created_at"],
          ["sort", "asc"],
        ])}`,
        decode: decodeIssueNotesJson,
      }).pipe(
        Effect.map((notes) => ({
          ...notes,
          nextCursor: notes.rawCount < PAGE_SIZE ? null : String(input.page + 1),
        })),
      );

    const awards = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly scope: string;
      readonly number: number;
      readonly operation: string;
      readonly cursor?: string | undefined;
    }) =>
      read({
        cwd: input.cwd,
        host: input.host,
        operation: input.operation,
        path: "graphql",
        method: "POST",
        body: {
          query: ISSUE_AWARD_EMOJI_GRAPHQL_QUERY,
          variables: {
            fullPath: input.scope.trim(),
            iid: String(input.number),
            cursor: input.cursor ?? null,
          },
        },
        decode: decodeAwardEmojiJson,
      });

    const linked = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly path: string;
      readonly endpoint: "closed_by" | "related_merge_requests";
    }) =>
      read({
        cwd: input.cwd,
        host: input.host,
        operation: "getIssue",
        path: paged(`${input.path}/${input.endpoint}`, 1),
        decode: (raw) => decodeLinkedMergeRequestsJson(raw, input.endpoint === "closed_by"),
      });

    const template =
      (input: { readonly cwd: string; readonly host: string; readonly scope: string }) =>
      (entry: GitLabTemplateEntry) =>
        read({
          cwd: input.cwd,
          host: input.host,
          operation: "listTemplates",
          path: `projects/${projectPath(input.scope)}/templates/issues/${encodeURIComponent(entry.key)}`,
          decode: (raw) => decodeTemplateJson(entry, raw),
        });

    return {
      kind: KIND,
      capabilities: CAPABILITIES,

      getViewer: (input) => viewer({ cwd: input.cwd, host: input.host, operation: "getViewer" }),

      listIssues: Effect.fn("GitLabIssueTracker.listIssues")(function* (input) {
        const page = parsePage(input.cursor);
        if (page === null) {
          return yield* refused("listIssues", "The cursor was not one GitLab handed out.");
        }
        const perPage = Math.min(Math.max(input.limit, 1), PAGE_SIZE);
        const text = input.query?.trim() ?? "";
        const alsoAssignedTo =
          input.involvement === "assigned" && input.assignee !== undefined
            ? input.viewer.toLowerCase()
            : null;
        return yield* read({
          cwd: input.cwd,
          host: input.host,
          operation: "listIssues",
          path: `projects/${projectPath(input.scope)}/issues?${query([
            ["state", input.state === "open" ? "opened" : input.state],
            ...involvementParams(input),
            // GitLab's own `search` matches title and description, URL-encoded like every other
            // value here, so no text in it can become a parameter of its own.
            ...(text.length === 0 ? [] : [["search", text] as const]),
            ...(input.labels === undefined || input.labels.length === 0
              ? []
              : [["labels", input.labels.join(",")] as const]),
            ...(input.assignee === undefined
              ? []
              : [["assignee_username", input.assignee] as const]),
            ["order_by", input.sort === "created" ? "created_at" : "updated_at"],
            ["sort", "desc"],
            ["per_page", String(perPage)],
            ["page", String(page)],
          ])}`,
          decode: decodeIssueListJson,
        }).pipe(
          Effect.map((list) => ({
            items:
              alsoAssignedTo === null
                ? list.items
                : list.items.filter((issue) =>
                    issue.assignees.some((actor) => actor.login.toLowerCase() === alsoAssignedTo),
                  ),
            nextCursor: list.rawCount < perPage ? null : String(page + 1),
          })),
        );
      }),

      getIssue: (input) =>
        issuePath(input, "getIssue").pipe(
          Effect.flatMap(({ number, path }) =>
            Effect.all(
              [
                read({
                  cwd: input.cwd,
                  host: input.host,
                  operation: "getIssue",
                  path,
                  decode: decodeIssueDetailJson,
                }),
                viewer({ cwd: input.cwd, host: input.host, operation: "getIssue" }),
                notesPage({
                  cwd: input.cwd,
                  host: input.host,
                  path,
                  page: 1,
                  operation: "getIssue",
                }),
                read({
                  cwd: input.cwd,
                  host: input.host,
                  operation: "getIssue",
                  path: paged(`${path}/resource_label_events`, 1),
                  decode: decodeLabelEventsJson,
                }),
                linked({ cwd: input.cwd, host: input.host, path, endpoint: "closed_by" }),
                linked({
                  cwd: input.cwd,
                  host: input.host,
                  path,
                  endpoint: "related_merge_requests",
                }),
                awards({
                  cwd: input.cwd,
                  host: input.host,
                  scope: input.scope,
                  number,
                  operation: "getIssue",
                }),
              ],
              { concurrency: 4 },
            ),
          ),
          Effect.map(([issue, viewerLogin, notes, labelEvents, closing, related, awardPage]) => {
            const closingKeys = new Set(closing.map((link) => `${link.repository}!${link.number}`));
            return {
              ...issue,
              viewer: viewerLogin,
              viewerPermissions: VIEWER_PERMISSIONS,
              reactions: awardPage.reactions,
              comments: notes.comments.map((comment) => ({
                ...comment,
                reactions: awardPage.reactionsByNoteId.get(comment.id) ?? [],
              })),
              commentsCursor: commentsCursor(notes.nextCursor, awardPage.nextCursor),
              events: [...notes.events, ...labelEvents].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt),
              ),
              // A merge request that closes the issue outranks its sighting as a mere mention.
              linkedPullRequests: [
                ...closing,
                ...related.filter((link) => !closingKeys.has(`${link.repository}!${link.number}`)),
              ],
            };
          }),
        ),

      getComments: (input) => {
        const cursor = parseCommentsCursor(input.cursor);
        return cursor === null
          ? Effect.fail(refused("getComments", "The cursor was not one GitLab handed out."))
          : issuePath(input, "getComments").pipe(
              Effect.flatMap(({ number, path }) =>
                Effect.all(
                  [
                    notesPage({
                      cwd: input.cwd,
                      host: input.host,
                      path,
                      page: cursor.page,
                      operation: "getComments",
                    }),
                    // Without its awards cursor a later page's awards cannot be found.
                    cursor.awards === null && cursor.page > 1
                      ? Effect.succeed(null)
                      : awards({
                          cwd: input.cwd,
                          host: input.host,
                          scope: input.scope,
                          number,
                          operation: "getComments",
                          cursor: cursor.awards ?? undefined,
                        }),
                  ],
                  { concurrency: 2 },
                ),
              ),
              Effect.map(([notes, awardPage]) => ({
                comments: notes.comments.map((comment) => ({
                  ...comment,
                  reactions: awardPage?.reactionsByNoteId.get(comment.id) ?? [],
                })),
                nextCursor: commentsCursor(notes.nextCursor, awardPage?.nextCursor ?? null),
              })),
            );
      },

      create: (input) =>
        assigneeIds(input, "create", input.assignees).pipe(
          Effect.flatMap((assignee_ids) =>
            read({
              cwd: input.cwd,
              host: input.host,
              operation: "create",
              path: `projects/${projectPath(input.scope)}/issues`,
              method: "POST",
              body: {
                title: input.title,
                description: input.body,
                labels: input.labels.join(","),
                assignee_ids,
              },
              decode: decodeCreatedIssueJson,
            }),
          ),
          Effect.map((issue) => ({
            key: String(issue.number),
            displayKey: `#${issue.number}`,
            url: issue.url,
          })),
        ),

      comment: (input) =>
        issuePath(input, "comment").pipe(
          Effect.flatMap(({ path }) =>
            write({
              cwd: input.cwd,
              host: input.host,
              operation: "comment",
              path: `${path}/notes`,
              method: "POST",
              body: { body: input.body },
            }),
          ),
        ),

      update: (input) =>
        Effect.all([
          issuePath(input, "update"),
          input.assignees === undefined
            ? Effect.void
            : assigneeIds(input, "update", input.assignees),
        ]).pipe(
          Effect.flatMap(([{ path }, assignee_ids]) =>
            write({
              cwd: input.cwd,
              host: input.host,
              operation: "update",
              path,
              method: "PUT",
              body: {
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.body === undefined ? {} : { description: input.body }),
                ...(input.labels === undefined ? {} : { labels: input.labels.join(",") }),
                ...(assignee_ids === undefined ? {} : { assignee_ids }),
              },
            }),
          ),
        ),

      setState: (input) =>
        issuePath(input, "setState").pipe(
          Effect.flatMap(({ path }) =>
            write({
              cwd: input.cwd,
              host: input.host,
              operation: "setState",
              path,
              method: "PUT",
              body: { state_event: input.state === "closed" ? "close" : "reopen" },
            }),
          ),
        ),

      setReaction: Effect.fn("GitLabIssueTracker.setReaction")(function* (input) {
        const { path } = yield* issuePath(input, "setReaction");
        if (input.subjectId !== undefined && !/^[1-9]\d*$/.test(input.subjectId)) {
          return yield* refused("setReaction", "The comment id names no GitLab note.");
        }
        const subject =
          input.subjectId === undefined
            ? `${path}/award_emoji`
            : `${path}/notes/${input.subjectId}/award_emoji`;
        if (input.reacted) {
          return yield* write({
            cwd: input.cwd,
            host: input.host,
            operation: "setReaction",
            path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
            method: "POST",
          });
        }
        // GitLab deletes an award by its id and takes no emoji name there, so the reader's own
        // award of that name is looked up first. Nothing to delete is success.
        const login = yield* viewer({
          cwd: input.cwd,
          host: input.host,
          operation: "setReaction",
        });
        for (let page = 1; ; page++) {
          const own = yield* read({
            cwd: input.cwd,
            host: input.host,
            operation: "setReaction",
            path: paged(subject, page),
            decode: (raw) => decodeOwnAwardIdJson(raw, { content: input.content, viewer: login }),
          });
          if (own.id !== null) {
            return yield* write({
              cwd: input.cwd,
              host: input.host,
              operation: "setReaction",
              path: `${subject}/${own.id}`,
              method: "DELETE",
            });
          }
          // An empty raw page establishes exhaustion even when the host caps page size.
          if (own.empty) return;
        }
      }),

      listTemplates: (input) =>
        read({
          cwd: input.cwd,
          host: input.host,
          operation: "listTemplates",
          path: `projects/${projectPath(input.scope)}/templates/issues`,
          decode: decodeTemplateEntriesJson,
        }).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(entries.slice(0, TEMPLATE_LIMIT), template(input), { concurrency: 4 }),
          ),
          // GitLab has no switch that forbids an issue filed from nothing.
          Effect.map((templates) => ({ templates, blankIssuesEnabled: true })),
        ),

      listCandidates: (input) =>
        Effect.all(
          [
            read({
              cwd: input.cwd,
              host: input.host,
              operation: "listCandidates",
              path: paged(`projects/${projectPath(input.scope)}/labels`, 1),
              decode: decodeProjectLabelsJson,
            }),
            read({
              cwd: input.cwd,
              host: input.host,
              operation: "listCandidates",
              path: paged(`projects/${projectPath(input.scope)}/members/all`, 1),
              decode: decodeProjectMembersJson,
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([labels, assignees]) => ({
            labels,
            assignees,
            truncated: labels.length >= PAGE_SIZE || assignees.length >= PAGE_SIZE,
          })),
        ),
    };
  },
);
