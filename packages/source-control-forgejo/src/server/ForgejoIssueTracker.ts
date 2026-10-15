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
import * as RegExpUtils from "effect/RegExp";
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
  involvements: ["all", "assigned", "authored", "mentioned"],
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
const COMMENT_PAGE_CURSOR = /^page:([1-9]\d{0,6}):([1-9]\d*)$/;

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

function assigneesMatch(
  expected: ReadonlyArray<string>,
  users: (typeof ForgejoIssue.Type)["assignees"],
): boolean {
  if (users === undefined) return false;
  const wanted = new Set(expected.map((login) => login.toLowerCase()));
  const actual = new Set((users ?? []).map((user) => user.login.toLowerCase()));
  return wanted.size === actual.size && [...wanted].every((login) => actual.has(login));
}

function permissions(repository: typeof ForgejoIssueRepository.Type): IssueViewerPermissions {
  const active = !repository.archived && repository.has_issues !== false;
  return {
    setState: active,
    comment: active,
    edit: active,
    labels: active,
    assignees: active,
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

    const labelIds = Effect.fn("ForgejoIssueTracker.labelIds")(function* (
      target: Target,
      operation: string,
      names: ReadonlyArray<string>,
      path?: string,
    ) {
      if (names.length === 0) return [];
      const wanted = [...new Set(names)].map(
        (name) => new RegExp(`^${RegExpUtils.escape(name)}$`, "iu"),
      );
      let labels = yield* readArray(
        target,
        operation,
        `${repoPath(target.scope)}/labels?limit=${PAGE_SIZE}`,
        ForgejoLabel,
      );
      if (
        path !== undefined &&
        wanted.some((pattern) => !labels.some((label) => pattern.test(label.name)))
      ) {
        const issue = yield* getIssue(target, operation, path);
        labels = [...labels, ...(issue.labels ?? [])];
      }
      if (wanted.some((pattern) => !labels.some((label) => pattern.test(label.name)))) {
        const organization = yield* organizationLabels(target, operation);
        labels = [...labels, ...organization.rows];
      }
      const ids = wanted.flatMap((pattern) => {
        const label = labels.find((candidate) => pattern.test(candidate.name));
        return label ? [label.id] : [];
      });
      if (ids.length !== wanted.length)
        return yield* refused(
          operation,
          "A requested label was not in the native label page. No fields were changed.",
        );
      return [...new Set(ids)];
    });

    /** One page of a listing, and whether Forgejo's `Link` header announced another. */
    const readPage = <A>(
      target: Target,
      operation: string,
      path: string,
      page: number,
      schema: Schema.Codec<A, unknown, never, never>,
      limit = PAGE_SIZE,
    ): Effect.Effect<
      {
        readonly rows: ReadonlyArray<A>;
        readonly nextCursor: string | null;
        readonly paginationKnown: boolean;
      },
      IssueTrackerError
    > =>
      request(target, operation, {
        path: `${path}${path.includes("?") ? "&" : "?"}limit=${limit}&page=${page}`,
      }).pipe(
        Effect.flatMap((result) => {
          if (result.stdoutTruncated)
            return Effect.fail(refused(operation, "Forgejo response exceeded the output limit."));
          const decoded = decodeJsonResult(Schema.NullOr(Schema.Array(schema)))(result.stdout);
          if (Result.isFailure(decoded)) {
            return Effect.fail(
              refused(operation, "Forgejo returned an invalid response.", decoded.failure),
            );
          }
          const rows = decoded.success ?? [];
          const links = /^link:\s*(.*)$/im.exec(result.stderr)?.[1];
          const more = links === undefined ? rows.length > 0 : /rel="?next"?/i.test(links);
          return Effect.succeed({
            rows,
            nextCursor: more ? String(page + 1) : null,
            paginationKnown: links !== undefined,
          });
        }),
      );

    const organizationLabels = (target: Target, operation: string) =>
      readPage(
        target,
        operation,
        `orgs/${encodeURIComponent(target.scope.split("/").at(-2)!)}/labels`,
        1,
        ForgejoLabel,
      ).pipe(
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeed({ rows: [], nextCursor: null, paginationKnown: true }),
        ),
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

    const commentsPage = Effect.fn("ForgejoIssueTracker.commentsPage")(function* (
      target: Target,
      operation: string,
      path: string,
      cursor: string | undefined,
      viewer: string,
    ) {
      const offsetMatch = /^offset:(?:([1-9]\d{0,6}):)?([1-9]\d{0,8})$/.exec(cursor ?? "");
      const pageMatch = COMMENT_PAGE_CURSOR.exec(cursor ?? "");
      const page = offsetMatch
        ? Number(offsetMatch[1] ?? 1)
        : pageMatch
          ? Number(pageMatch[1])
          : parsePage(cursor);
      if (page === null)
        return yield* refused(operation, "The cursor was not one Forgejo handed out.");
      const result = yield* request(target, operation, {
        path: `${path}/comments?limit=${PAGE_SIZE}&page=${page}`,
      });
      if (result.stdoutTruncated)
        return yield* refused(operation, "Forgejo response exceeded the output limit.");
      const decoded = decodeJsonResult(Schema.NullOr(Schema.Array(ForgejoComment)))(result.stdout);
      if (Result.isFailure(decoded))
        return yield* refused(operation, "Forgejo returned an invalid response.", decoded.failure);
      const rows = decoded.success ?? [];
      const links = /^link:\s*(.*)$/im.exec(result.stderr)?.[1];
      const seenAt = pageMatch ? rows.findIndex((row) => row.id === Number(pageMatch[2])) : -1;
      const offset = offsetMatch ? Number(offsetMatch[2]) : seenAt + 1;
      const selected = rows.slice(offset, offset + COMMENT_REACTION_LIMIT);
      const last = selected.at(-1);
      let nextCursor: string | null = null;
      if (last) {
        if (offset + selected.length < rows.length)
          nextCursor = `offset:${page}:${offset + selected.length}`;
        else if (links !== undefined) {
          if (/rel="?next"?/i.test(links)) nextCursor = String(page + 1);
        } else nextCursor = `page:${page + 1}:${last.id}`;
      }
      const comments = yield* Effect.forEach(
        selected,
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
      );
      return { comments, nextCursor };
    });

    /** Pull requests the timeline shows citing this issue, each read once for its state. */
    const linkedPullRequests = (
      target: Target,
      timeline: ReadonlyArray<typeof ForgejoTimelineEntry.Type>,
      issueUrl: string,
    ): Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, IssueTrackerError> => {
      const currentMount = URL.parse(issueUrl)?.pathname.match(
        /^(.*)\/[^/]+\/[^/]+\/issues\/[1-9]\d*\/?$/,
      )?.[1];
      const references = new Map<
        string,
        {
          readonly repository: string;
          readonly number: number;
          readonly url: string;
          readonly mount: string;
        }
      >();
      for (const entry of timeline) {
        const reference = entry.ref_issue;
        if (
          entry.type !== "pull_ref" ||
          !reference?.pull_request ||
          !URL.canParse(reference.html_url)
        )
          continue;
        const url = new URL(reference.html_url);
        const match = /\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d*)\/?$/.exec(url.pathname);
        if (
          !match ||
          !["http:", "https:"].includes(url.protocol) ||
          url.host.toLowerCase() !== target.host.toLowerCase() ||
          Number(match[3]) !== reference.number
        )
          continue;
        const mount = url.pathname.slice(0, match.index);
        const repository = `${mount ? `${mount.slice(1)}/` : ""}${match[1]}/${match[2]}`;
        references.set(`${repository}/${reference.number}`, {
          repository,
          number: reference.number,
          url: reference.html_url,
          mount,
        });
      }
      return Effect.forEach(
        [...references.values()],
        ({ repository, number, url, mount }) => {
          if (mount !== currentMount)
            return Effect.succeed<ReadonlyArray<IssueLinkedPullRequest>>([
              {
                repository,
                number,
                title: `#${number}`,
                url,
                state: null,
                isDraft: false,
                closesIssue: false,
              },
            ]);
          return read(
            { ...target, scope: repository },
            "getIssue",
            { path: `${repoPath(repository)}/pulls/${number}` },
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
                repository,
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
          );
        },
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
          Math.min(input.limit, PAGE_SIZE),
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
                readPage(input, "getIssue", `${path}/reactions`, 1, ForgejoReaction),
              ],
              { concurrency: 3 },
            ),
          ),
          Effect.flatMap(([issue, repository, viewer, timeline, reactions]) =>
            Effect.all([
              commentsPage(
                input,
                "getIssue",
                issuePath(input.scope, issue.number),
                undefined,
                viewer,
              ),
              linkedPullRequests(input, timeline.rows, issue.html_url),
            ]).pipe(
              Effect.map(([conversation, links]) => ({
                ...forgejoIssue(issue),
                body: issue.body ?? "",
                viewer,
                viewerPermissions: permissions(repository),
                reactions: forgejoReactions(reactions.rows, viewer),
                reactionsTruncated: !reactions.paginationKnown || reactions.nextCursor !== null,
                comments: conversation.comments,
                commentsCursor: conversation.nextCursor,
                events: timeline.rows.flatMap((entry) => forgejoIssueEvent(entry) ?? []),
                linkedPullRequests: links,
                historyTruncated: !timeline.paginationKnown || timeline.nextCursor !== null,
              })),
            ),
          ),
        ),

      getComments: (input) => {
        const validCursor =
          parsePage(input.cursor) !== null ||
          /^offset:(?:[1-9]\d{0,6}:)?[1-9]\d{0,8}$/.test(input.cursor) ||
          COMMENT_PAGE_CURSOR.test(input.cursor);
        return !validCursor
          ? Effect.fail(refused("getComments", "The cursor was not one Forgejo handed out."))
          : Effect.all([issueTarget("getComments", input), getViewer(input, "getComments")]).pipe(
              Effect.flatMap(([{ path }, viewer]) =>
                commentsPage(input, "getComments", path, input.cursor, viewer),
              ),
            );
      },

      getViewerPermissions: (input) =>
        issueTarget("getViewerPermissions", input).pipe(
          Effect.flatMap(() => getRepository(input, "getViewerPermissions")),
          Effect.map(permissions),
        ),

      create: (input) =>
        // Labels are written by id, so the names are resolved against the repository's own first.
        labelIds(input, "create", input.labels).pipe(
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
                  labels,
                  assignees: input.assignees,
                },
              },
              ForgejoIssue,
            ).pipe(
              Effect.map((issue) => {
                const warnings: string[] = [];
                if (labels.some((id) => !issue.labels?.some((label) => label.id === id)))
                  warnings.push(
                    "The issue was created, but the requested labels were not applied.",
                  );
                if (input.assignees.length > 0 && !assigneesMatch(input.assignees, issue.assignees))
                  warnings.push(
                    "The issue was created, but its assignees do not match the selection.",
                  );
                return {
                  key: String(issue.number),
                  displayKey: `#${issue.number}`,
                  url: issue.html_url,
                  ...(warnings.length > 0 ? { warnings } : {}),
                };
              }),
            ),
          ),
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
        Effect.gen(function* () {
          const { path } = yield* issueTarget("update", input);
          const labels =
            input.labels === undefined
              ? undefined
              : yield* labelIds(input, "update", input.labels, path);
          if (
            input.title !== undefined ||
            input.body !== undefined ||
            input.assignees !== undefined
          ) {
            const issue = yield* read(
              input,
              "update",
              {
                path,
                method: "PATCH",
                body: {
                  ...(input.title === undefined ? {} : { title: input.title }),
                  ...(input.body === undefined ? {} : { body: input.body }),
                  ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
                },
              },
              ForgejoIssue,
            );
            if (input.assignees !== undefined && !assigneesMatch(input.assignees, issue.assignees))
              return yield* refused(
                "update",
                "Forgejo did not apply the requested assignees. Other fields may have changed.",
              );
          }
          if (labels !== undefined)
            yield* write(input, "update", {
              path: `${path}/labels`,
              method: "PUT",
              body: {
                labels,
              },
            });
        }),

      setState: (input) =>
        issueTarget("setState", input).pipe(
          Effect.flatMap(({ path }) =>
            write(input, "setState", { path, method: "PATCH", body: { state: input.state } }),
          ),
        ),

      setReaction: (input) =>
        Effect.gen(function* () {
          const { number, path } = yield* issueTarget("setReaction", input);
          let reactionPath = `${path}/reactions`;
          if (input.subjectId !== undefined) {
            if (!/^[1-9]\d*$/.test(input.subjectId))
              return yield* refused("setReaction", "The comment id names no Forgejo comment.");
            const commentPath = `${repoPath(input.scope)}/issues/comments/${input.subjectId}`;
            const comment = yield* read(
              input,
              "setReaction",
              { path: commentPath },
              Schema.Struct({ id: Schema.Int, issue_url: Schema.String }),
            );
            const url = URL.parse(comment.issue_url);
            const segments = input.scope.split("/").map(encodeURIComponent);
            const scopePath = segments.slice(-2).join("/");
            const mountPath = segments.slice(0, -2).join("/");
            const ownerPath = url?.pathname.replace(/\/$/, "");
            const nativeScopePath = ownerPath?.split("/").slice(-4, -2).join("/");
            const issueSuffix = `/${nativeScopePath}/issues/${number}`;
            if (
              String(comment.id) !== input.subjectId ||
              url === null ||
              !["http:", "https:"].includes(url.protocol) ||
              url.host.toLowerCase() !== input.host.toLowerCase() ||
              nativeScopePath?.toLowerCase() !== scopePath.toLowerCase() ||
              !ownerPath?.endsWith(issueSuffix) ||
              (mountPath !== "" &&
                ownerPath !== `/${mountPath}${issueSuffix}` &&
                ownerPath !== `/${mountPath}/api/v1/repos${issueSuffix}`)
            )
              return yield* refused("setReaction", "The comment does not belong to this issue.");
            reactionPath = `${commentPath}/reactions`;
          }
          yield* write(input, "setReaction", {
            path: reactionPath,
            method: input.reacted ? "POST" : "DELETE",
            body: { content: FORGEJO_REACTIONS[input.content] },
          });
        }),

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
            organizationLabels(input, "listCandidates"),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([labels, assignees, organization]) => ({
            labels: [...labels.rows, ...organization.rows]
              .filter(
                (label, index, rows) =>
                  rows.findIndex((candidate) => candidate.name === label.name) === index,
              )
              .map((label) => ({
                name: label.name,
                color: label.color ?? null,
                description: label.description ?? null,
              })),
            assignees: assignees.rows.flatMap((user) => {
              const actor = forgejoActor(user);
              return actor === null ? [] : [{ ...actor, id: actor.login }];
            }),
            truncated:
              labels.nextCursor !== null ||
              assignees.nextCursor !== null ||
              organization.nextCursor !== null,
          })),
        ),
    };
  },
);
