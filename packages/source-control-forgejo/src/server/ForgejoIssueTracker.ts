/**
 * Forgejo's issue tracker, over the same `ForgejoCli.api` the pull request reads use: it resolves
 * the server, its port and the login from the checkout's remote, so a self-hosted instance on a
 * custom host is addressed the way its merge requests already are.
 *
 * Forgejo pages by number and announces a next page in a `Link` header, which the CLI surfaces
 * on stderr; every cursor here is the next page number.
 *
 * @module source-control-forgejo/server/ForgejoIssueTracker
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  type IssueCapabilities,
  type IssueLinkedPullRequest,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import {
  IssueTrackerError,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as ForgejoCli from "./ForgejoCli.ts";
import {
  ForgejoIssue,
  ForgejoIssueConfig,
  ForgejoIssueRepository,
  ForgejoIssueTemplate,
  ForgejoTimelineEntry,
  forgejoIssue,
  forgejoIssueComment,
  forgejoIssueEvent,
  forgejoIssueTemplate,
} from "./forgejoIssueJson.ts";
import {
  FORGEJO_REACTIONS,
  ForgejoComment,
  ForgejoLabel,
  ForgejoReaction,
  ForgejoUser,
  forgejoActor,
  forgejoReactions,
} from "./forgejoPullRequestJson.ts";

const KIND = IssueTrackerKind.make("forgejo");

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
  closeReasons: [],
};

/** Forgejo's own ceiling on a page, which a self-hosted server may lower. */
const PAGE_SIZE = 50;
/** Comment reactions are a request each, so only the first page's are read with the detail. */
const COMMENT_REACTION_LIMIT = 50;

const repoPath = (scope: string) => `repos/${scope.split("/").map(encodeURIComponent).join("/")}`;
const issuePath = (scope: string, number: number) => `${repoPath(scope)}/issues/${number}`;

function parseNumber(key: string): number | null {
  return /^[1-9]\d*$/.test(key) ? Number(key) : null;
}

function parsePage(cursor: string | undefined): number | null {
  if (cursor === undefined) return 1;
  return /^[1-9]\d{0,6}$/.test(cursor) ? Number(cursor) : null;
}

function reasonFor(error: ForgejoCli.ForgejoCliError): IssueTrackerError["reason"] {
  switch (error.reason) {
    case "missing-cli":
      return "missing-tool";
    case "authentication":
      return "unauthenticated";
    case "rate-limit":
      return "rate-limited";
    case "not-found":
      return "not-found";
    default:
      return "failed";
  }
}

/**
 * What the signed-in account may do. Forgejo reports push access on the repository, and an
 * issue's author may edit and close their own; an archived repository takes everything away, and
 * a locked issue takes commenting away from anyone without push.
 */
function permissions(
  repository: typeof ForgejoIssueRepository.Type,
  issue: typeof ForgejoIssue.Type,
  viewer: string,
): IssueViewerPermissions {
  const active = !repository.archived;
  const canWrite = repository.permissions?.push ?? false;
  const canEdit = canWrite || issue.user?.login === viewer;
  return {
    setState: active && canEdit,
    comment: active && (!issue.is_locked || canWrite),
    edit: active && canEdit,
    labels: active && canWrite,
    assignees: active && canWrite,
  };
}

export const make: Effect.Effect<IssueTrackerApi, never, ForgejoCli.ForgejoCli> = Effect.gen(
  function* () {
    const cli = yield* ForgejoCli.ForgejoCli;

    const refused = (operation: string, detail: string, cause?: unknown) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "failed",
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

    const notFound = (operation: string) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "not-found",
        detail: "Forgejo could not find the requested issue.",
      });

    type Target = { readonly cwd: string; readonly host: string; readonly scope: string };

    const request = (
      target: Target,
      operation: string,
      input: Omit<ForgejoCli.ForgejoApiInput, "cwd" | "repository" | "host">,
    ) =>
      cli.api({ cwd: target.cwd, repository: target.scope, host: target.host, ...input }).pipe(
        Effect.mapError(
          (error) =>
            new IssueTrackerError({
              tracker: KIND,
              operation,
              reason: reasonFor(error),
              detail: error.detail,
              cause: error,
            }),
        ),
      );

    const read = <A>(
      target: Target,
      operation: string,
      input: Omit<ForgejoCli.ForgejoApiInput, "cwd" | "repository" | "host">,
      schema: Schema.Codec<A, unknown, never, never>,
    ): Effect.Effect<A, IssueTrackerError> =>
      request(target, operation, input).pipe(
        Effect.flatMap((result) => {
          if (result.stdoutTruncated) {
            return Effect.fail(refused(operation, "Forgejo response exceeded the output limit."));
          }
          const decoded = decodeJsonResult(schema)(result.stdout);
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                refused(operation, "Forgejo returned an invalid response.", decoded.failure),
              );
        }),
      );

    const readArray = <A>(
      target: Target,
      operation: string,
      path: string,
      schema: Schema.Codec<A, unknown, never, never>,
    ) =>
      read(target, operation, { path }, Schema.NullOr(Schema.Array(schema))).pipe(
        Effect.map((rows) => rows ?? []),
      );

    /** One page of a listing, and whether Forgejo's `Link` header announced another. */
    const readPage = <A>(
      target: Target,
      operation: string,
      path: string,
      page: number,
      schema: Schema.Codec<A, unknown, never, never>,
    ): Effect.Effect<
      { readonly rows: ReadonlyArray<A>; readonly nextCursor: string | null },
      IssueTrackerError
    > =>
      request(target, operation, {
        path: `${path}${path.includes("?") ? "&" : "?"}limit=${PAGE_SIZE}&page=${page}`,
      }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeJsonResult(Schema.NullOr(Schema.Array(schema)))(result.stdout);
          if (Result.isFailure(decoded)) {
            return Effect.fail(
              refused(operation, "Forgejo returned an invalid response.", decoded.failure),
            );
          }
          const rows = decoded.success ?? [];
          const links = /^link:\s*(.*)$/im.exec(result.stderr)?.[1];
          const more = rows.length > 0 && (links === undefined || /rel="?next"?/i.test(links));
          return Effect.succeed({ rows, nextCursor: more ? String(page + 1) : null });
        }),
      );

    const write = (
      target: Target,
      operation: string,
      input: Omit<ForgejoCli.ForgejoApiInput, "cwd" | "repository" | "host">,
    ) => request(target, operation, input).pipe(Effect.asVoid);

    const getViewer = (target: Target, operation: string) =>
      read(target, operation, { path: "user" }, ForgejoUser).pipe(Effect.map((user) => user.login));

    const getRepository = (target: Target, operation: string) =>
      read(target, operation, { path: repoPath(target.scope) }, ForgejoIssueRepository);

    /** The issue as the API addresses it, or a not-found for a key that names no number. */
    const issueTarget = (
      operation: string,
      input: Target & { readonly key: string },
    ): Effect.Effect<{ readonly number: number; readonly path: string }, IssueTrackerError> => {
      const number = parseNumber(input.key);
      return number === null
        ? Effect.fail(notFound(operation))
        : Effect.succeed({ number, path: issuePath(input.scope, number) });
    };

    const getIssue = (target: Target, operation: string, path: string) =>
      read(target, operation, { path }, ForgejoIssue).pipe(
        // The issues API answers for a pull request's number too; that is not an issue here.
        Effect.filterOrFail(
          (issue) => !issue.pull_request,
          () => notFound(operation),
        ),
      );

    const commentsPage = (
      target: Target,
      operation: string,
      path: string,
      page: number,
      viewer: string,
    ) =>
      readPage(target, operation, `${path}/comments`, page, ForgejoComment).pipe(
        Effect.flatMap(({ rows, nextCursor }) =>
          Effect.forEach(
            rows.slice(0, COMMENT_REACTION_LIMIT),
            (comment) =>
              readArray(
                target,
                operation,
                `${repoPath(target.scope)}/issues/comments/${comment.id}/reactions`,
                ForgejoReaction,
              ).pipe(
                Effect.map((reactions) => ({
                  ...forgejoIssueComment(comment),
                  reactions: forgejoReactions(reactions, viewer),
                })),
              ),
            { concurrency: 4 },
          ).pipe(Effect.map((comments) => ({ comments, nextCursor }))),
        ),
      );

    /** Pull requests the timeline shows citing this issue, each read once for its state. */
    const linkedPullRequests = (
      target: Target,
      timeline: ReadonlyArray<typeof ForgejoTimelineEntry.Type>,
    ): Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, IssueTrackerError> => {
      const numbers = [
        ...new Set(
          timeline.flatMap((entry) =>
            entry.type === "pull_ref" && entry.ref_issue?.pull_request
              ? [entry.ref_issue.number]
              : [],
          ),
        ),
      ];
      return Effect.forEach(
        numbers,
        (number) =>
          read(
            target,
            "getIssue",
            { path: `${repoPath(target.scope)}/pulls/${number}` },
            Schema.Struct({
              number: Schema.Int,
              title: Schema.String,
              html_url: Schema.String,
              state: Schema.String,
              merged: Schema.Boolean,
              draft: Schema.optional(Schema.Boolean),
            }),
          ).pipe(
            Effect.map((pull) => [
              {
                repository: target.scope,
                number: pull.number,
                title: pull.title,
                url: pull.html_url,
                state: pull.merged
                  ? ("merged" as const)
                  : pull.state === "closed"
                    ? ("closed" as const)
                    : ("open" as const),
                isDraft: pull.draft ?? false,
                // Forgejo's timeline cites the pull request without saying whether it closes the issue.
                closesIssue: false,
              },
            ]),
            Effect.catchIf(
              (error) => error.reason === "not-found",
              () => Effect.succeed([]),
            ),
          ),
        { concurrency: 2 },
      ).pipe(Effect.map((links) => links.flat()));
    };

    return {
      kind: KIND,
      capabilities: CAPABILITIES,

      getViewer: (input) => getViewer({ ...input, scope: "" }, "getViewer"),

      listIssues: (input) => {
        const page = parsePage(input.cursor);
        if (page === null) {
          return Effect.fail(refused("listIssues", "The cursor was not one Forgejo handed out."));
        }
        const params = new URLSearchParams({
          type: "issues",
          state: input.state,
          sort: "recentupdate",
        });
        const text = input.query?.trim() ?? "";
        if (text.length > 0) params.set("q", text);
        const involvement =
          input.involvement === "assigned"
            ? "assigned_by"
            : input.involvement === "authored"
              ? "created_by"
              : input.involvement === "mentioned"
                ? "mentioned_by"
                : null;
        if (involvement !== null) params.set(involvement, input.viewer);
        return readPage(
          input,
          "listIssues",
          `${repoPath(input.scope)}/issues?${params}`,
          page,
          ForgejoIssue,
        ).pipe(
          Effect.map(({ rows, nextCursor }) => ({
            items: rows.flatMap((issue) => (issue.pull_request ? [] : [forgejoIssue(issue)])),
            nextCursor,
          })),
        );
      },

      getIssue: (input) =>
        issueTarget("getIssue", input).pipe(
          Effect.flatMap(({ path }) =>
            Effect.all(
              [
                getIssue(input, "getIssue", path),
                getRepository(input, "getIssue"),
                getViewer(input, "getIssue"),
                readPage(input, "getIssue", `${path}/timeline`, 1, ForgejoTimelineEntry),
                readArray(input, "getIssue", `${path}/reactions`, ForgejoReaction),
              ],
              { concurrency: 3 },
            ),
          ),
          Effect.flatMap(([issue, repository, viewer, timeline, reactions]) =>
            Effect.all([
              commentsPage(input, "getIssue", issuePath(input.scope, issue.number), 1, viewer),
              linkedPullRequests(input, timeline.rows),
            ]).pipe(
              Effect.map(([conversation, links]) => ({
                ...forgejoIssue(issue),
                body: issue.body ?? "",
                viewer,
                viewerPermissions: permissions(repository, issue, viewer),
                reactions: forgejoReactions(reactions, viewer),
                comments: conversation.comments,
                commentsCursor: conversation.nextCursor,
                events: timeline.rows.flatMap((entry) => forgejoIssueEvent(entry) ?? []),
                linkedPullRequests: links,
              })),
            ),
          ),
        ),

      getComments: (input) => {
        const page = parsePage(input.cursor);
        return page === null
          ? Effect.fail(refused("getComments", "The cursor was not one Forgejo handed out."))
          : Effect.all([issueTarget("getComments", input), getViewer(input, "getComments")]).pipe(
              Effect.flatMap(([{ path }, viewer]) =>
                commentsPage(input, "getComments", path, page, viewer),
              ),
            );
      },

      getViewerPermissions: (input) =>
        issueTarget("getViewerPermissions", input).pipe(
          Effect.flatMap(({ path }) =>
            Effect.all(
              [
                getIssue(input, "getViewerPermissions", path),
                getRepository(input, "getViewerPermissions"),
                getViewer(input, "getViewerPermissions"),
              ],
              { concurrency: 3 },
            ),
          ),
          Effect.map(([issue, repository, viewer]) => permissions(repository, issue, viewer)),
        ),

      create: (input) =>
        // Labels are written by id, so the names are resolved against the repository's own first.
        readArray(
          input,
          "create",
          `${repoPath(input.scope)}/labels?limit=${PAGE_SIZE}`,
          ForgejoLabel,
        ).pipe(
          Effect.flatMap((labels) =>
            read(
              input,
              "create",
              {
                path: `${repoPath(input.scope)}/issues`,
                method: "POST",
                body: {
                  title: input.title,
                  body: input.body,
                  labels: labels.flatMap((label) =>
                    input.labels.includes(label.name) ? [label.id] : [],
                  ),
                  assignees: input.assignees,
                },
              },
              ForgejoIssue,
            ),
          ),
          Effect.map((issue) => ({
            key: String(issue.number),
            displayKey: `#${issue.number}`,
            url: issue.html_url,
          })),
        ),

      comment: (input) =>
        issueTarget("comment", input).pipe(
          Effect.flatMap(({ path }) =>
            write(input, "comment", {
              path: `${path}/comments`,
              method: "POST",
              body: { body: input.body },
            }),
          ),
        ),

      update: (input) =>
        issueTarget("update", input).pipe(
          Effect.flatMap(({ path }) =>
            Effect.all([
              input.title === undefined && input.body === undefined && input.assignees === undefined
                ? Effect.void
                : write(input, "update", {
                    path,
                    method: "PATCH",
                    body: {
                      ...(input.title === undefined ? {} : { title: input.title }),
                      ...(input.body === undefined ? {} : { body: input.body }),
                      ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
                    },
                  }),
              input.labels === undefined
                ? Effect.void
                : readArray(
                    input,
                    "update",
                    `${repoPath(input.scope)}/labels?limit=${PAGE_SIZE}`,
                    ForgejoLabel,
                  ).pipe(
                    Effect.flatMap((labels) =>
                      write(input, "update", {
                        path: `${path}/labels`,
                        method: "PUT",
                        body: {
                          labels: labels.flatMap((label) =>
                            input.labels!.includes(label.name) ? [label.id] : [],
                          ),
                        },
                      }),
                    ),
                  ),
            ]),
          ),
          Effect.asVoid,
        ),

      setState: (input) =>
        issueTarget("setState", input).pipe(
          Effect.flatMap(({ path }) =>
            write(input, "setState", { path, method: "PATCH", body: { state: input.state } }),
          ),
        ),

      setReaction: (input) =>
        issueTarget("setReaction", input).pipe(
          Effect.flatMap(({ path }) => {
            if (input.subjectId !== undefined && !/^[1-9]\d*$/.test(input.subjectId)) {
              return Effect.fail(
                refused("setReaction", "The comment id names no Forgejo comment."),
              );
            }
            return write(input, "setReaction", {
              path:
                input.subjectId === undefined
                  ? `${path}/reactions`
                  : `${repoPath(input.scope)}/issues/comments/${input.subjectId}/reactions`,
              method: input.reacted ? "POST" : "DELETE",
              body: { content: FORGEJO_REACTIONS[input.content] },
            });
          }),
        ),

      listTemplates: (input) =>
        Effect.all(
          [
            readArray(
              input,
              "listTemplates",
              `${repoPath(input.scope)}/issue_templates`,
              ForgejoIssueTemplate,
            ),
            // A repository with no config leaves the blank issue where Forgejo puts it.
            read(
              input,
              "listTemplates",
              { path: `${repoPath(input.scope)}/issue_config` },
              ForgejoIssueConfig,
            ).pipe(
              Effect.map((config) => config.blank_issues_enabled !== false),
              Effect.catchIf(
                (error) => error.reason === "not-found" || error.reason === "failed",
                () => Effect.succeed(true),
              ),
            ),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([templates, blankIssuesEnabled]) => ({
            templates: templates.flatMap((template) => forgejoIssueTemplate(template) ?? []),
            blankIssuesEnabled,
          })),
        ),

      listCandidates: (input) =>
        Effect.all(
          [
            readPage(input, "listCandidates", `${repoPath(input.scope)}/labels`, 1, ForgejoLabel),
            readPage(input, "listCandidates", `${repoPath(input.scope)}/assignees`, 1, ForgejoUser),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([labels, assignees]) => ({
            labels: labels.rows.map((label) => ({
              name: label.name,
              color: label.color ?? null,
              description: label.description ?? null,
            })),
            assignees: assignees.rows.flatMap((user) => {
              const actor = forgejoActor(user);
              return actor === null ? [] : [{ ...actor, id: actor.login }];
            }),
            truncated: labels.nextCursor !== null || assignees.nextCursor !== null,
          })),
        ),
    };
  },
);
