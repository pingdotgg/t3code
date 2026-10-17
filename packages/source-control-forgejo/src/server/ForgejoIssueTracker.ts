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
import * as RegExpUtils from "effect/RegExp";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  issueHostKey,
  type IssueCapabilities,
  type IssueListOrder,
  type IssueEvent,
  type IssuePageInput,
  type IssueLinkedPullRequest,
  type IssueViewerPermissions,
  type IssueDependency,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type IssueTarget,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as ForgejoCli from "./ForgejoCli.ts";
import {
  ForgejoDependencyIssue,
  forgejoDependency,
  forgejoDependencyScope,
  forgejoDependencyPagination,
} from "./forgejoIssueDependencies.ts";
import {
  ForgejoIssue,
  ForgejoIssueConfig,
  ForgejoIssueRepository,
  ForgejoIssueTemplate,
  ForgejoTimelineEntry,
  ForgejoConversationCursor,
  forgejoIssue,
  forgejoIssueComment,
  forgejoIssueEvent,
  forgejoIssueEventLinks,
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

const IssueCommentRecord = Schema.Struct({
  ...ForgejoComment.fields,
  updated_at: Schema.optional(Schema.String),
});
const KIND = IssueTrackerKind.make("forgejo");

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  editComment: true,
  subIssues: false,
  createSubIssue: false,
  updateParent: false,
  dependencies: true,
  listSorts: ["created"],
  listOrders: ["desc"],
  labels: true,
  assignees: true,
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  historyOrders: ["asc"],
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
const LABEL_LOOKUP_LIMIT = 5;
const LABEL_PAGE_LIMIT = 3;
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
    const cursorIdentity = (
      input: IssueTarget,
      operation: string,
      order: IssueListOrder,
      limit?: number,
    ) =>
      JSON.stringify([
        KIND,
        input.cwd,
        issueHostKey(input.host),
        input.scope,
        input.key,
        input.connectionId ?? null,
        operation,
        order,
        limit ?? null,
      ]);
    const saveCursor = (
      identity: string,
      native: string | null,
      lastId?: number,
      total?: number,
      lastAt?: string,
    ) => {
      if (native === null) return Effect.succeed(null);
      const cursor = JSON.stringify({
        version: 1,
        identity,
        native,
        ...(lastId === undefined ? {} : { lastId }),
        ...(total === undefined ? {} : { total }),
        ...(lastAt === undefined ? {} : { lastAt }),
      });
      return cursor.length <= 8192
        ? Effect.succeed(cursor)
        : Effect.fail(refused("comments", "The Forgejo cursor exceeds the supported size."));
    };

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

    const readCursor = (
      input: IssueTarget,
      operation: string,
      cursor: string | undefined,
      order: IssueListOrder,
      limit?: number,
    ): Effect.Effect<typeof ForgejoConversationCursor.Type | undefined, IssueTrackerError> => {
      if (cursor === undefined) return Effect.succeed(undefined);
      const decoded =
        cursor.length <= 8192 ? decodeJsonResult(ForgejoConversationCursor)(cursor) : undefined;
      if (
        decoded === undefined ||
        Result.isFailure(decoded) ||
        decoded.success.identity !== cursorIdentity(input, operation, order, limit)
      )
        return Effect.fail(
          refused(
            operation,
            "The Forgejo cursor does not match this account, issue or order. Refresh the conversation.",
          ),
        );
      const state = decoded.success;
      const offset = /^offset:1:([1-9]\d*)$/.exec(state.native)?.[1];
      if (
        operation === "comments" &&
        ((state.total !== undefined && (offset === undefined || Number(offset) >= state.total)) ||
          (order === "desc" && state.total === undefined))
      )
        return Effect.fail(refused(operation, "The Forgejo comment window is invalid."));
      return Effect.succeed(state);
    };

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

    const readWithRepository = <A>(
      target: Target,
      operation: string,
      input: Omit<ForgejoCli.ForgejoApiInput, "cwd" | "repository" | "host">,
      schema: Schema.Codec<A, unknown, never, never>,
    ) =>
      request(target, operation, input).pipe(
        Effect.flatMap((result) => {
          if (result.stdoutTruncated) {
            return Effect.fail(refused(operation, "Forgejo response exceeded the output limit."));
          }
          const decoded = decodeJsonResult(schema)(result.stdout);
          return Result.isSuccess(decoded)
            ? Effect.succeed({ value: decoded.success, repositoryUrl: result.repositoryUrl })
            : Effect.fail(
                refused(operation, "Forgejo returned an invalid response.", decoded.failure),
              );
        }),
      );

    const read = <A>(
      target: Target,
      operation: string,
      input: Omit<ForgejoCli.ForgejoApiInput, "cwd" | "repository" | "host">,
      schema: Schema.Codec<A, unknown, never, never>,
    ) =>
      readWithRepository(target, operation, input, schema).pipe(Effect.map(({ value }) => value));

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
      const wanted = [...new Set(names)].map((name) => {
        const id = /^forgejo-label:([1-9]\d*)$/.exec(name)?.[1];
        const pattern = new RegExp(`^${RegExpUtils.escape(name)}$`, "iu");
        return {
          name: id ?? name,
          id,
          matches: (label: typeof ForgejoLabel.Type) =>
            id === undefined ? pattern.test(label.name) : String(label.id) === id,
        };
      });
      const repository = yield* readPage(
        target,
        operation,
        `${repoPath(target.scope)}/labels`,
        1,
        ForgejoLabel,
      );
      let labels = repository.rows;
      const missing = (catalog = labels) => wanted.filter(({ matches }) => !catalog.some(matches));
      if (path !== undefined) {
        const issue = yield* getIssue(target, operation, path);
        labels = [...(issue.labels ?? []), ...labels];
      }
      let organizationLabelsFound: typeof labels = [];
      let organizationNext: string | null = null;
      if (missing().length > 0) {
        const organization = yield* organizationLabels(target, operation);
        organizationLabelsFound = organization.rows;
        organizationNext = organization.nextCursor;
      }
      const catalogs = [
        `${repoPath(target.scope)}/labels`,
        `orgs/${encodeURIComponent(target.scope.split("/").at(-2)!)}/labels`,
      ];
      let repositoryNext = repository.nextCursor;
      for (
        let page = 2;
        page <= LABEL_PAGE_LIMIT && repositoryNext !== null && missing().length > 0;
        page++
      ) {
        const result = yield* readPage(target, operation, catalogs[0]!, page, ForgejoLabel);
        labels = [...labels, ...result.rows];
        repositoryNext = result.nextCursor;
      }
      for (
        let page = 2;
        page <= LABEL_PAGE_LIMIT &&
        organizationNext !== null &&
        missing([...labels, ...organizationLabelsFound]).length > 0;
        page++
      ) {
        const result = yield* organizationLabels(target, operation, page);
        organizationLabelsFound = [...organizationLabelsFound, ...result.rows];
        organizationNext = result.nextCursor;
      }
      if (repositoryNext === null) labels = [...labels, ...organizationLabelsFound];
      const unresolved = missing();
      if (unresolved.length > LABEL_LOOKUP_LIMIT)
        return yield* refused(
          operation,
          "At most five labels outside the first native pages can be resolved per write. No fields were changed.",
        );
      for (const { name, id, matches } of unresolved) {
        if (id === undefined && (/^[+-]?\d+$/.test(name) || name === "." || name === ".."))
          continue;
        for (const [index, catalog] of catalogs.entries()) {
          const known = index === 1 ? organizationLabelsFound.find(matches) : undefined;
          const label =
            known ??
            (yield* read(
              target,
              operation,
              { path: `${catalog}/${encodeURIComponent(name)}` },
              ForgejoLabel,
            ).pipe(
              Effect.catchIf(
                (error) => error.reason === "not-found",
                () => Effect.succeed(null),
              ),
            ));
          if (label === null) continue;
          if (!matches(label) || label.id < 1)
            return yield* refused(
              operation,
              "Forgejo returned a different native label than requested. No fields were changed.",
            );
          labels = [...labels, label];
          break;
        }
      }
      const ids = wanted.flatMap(({ matches }) => {
        const label = labels.find(matches);
        return label ? [label.id] : [];
      });
      if (ids.length !== wanted.length || ids.some((id) => id < 1))
        return yield* refused(
          operation,
          "A requested label was not in the bounded native label catalog. No fields were changed.",
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

    const organizationLabels = (target: Target, operation: string, page = 1, limit = PAGE_SIZE) =>
      readPage(
        target,
        operation,
        `orgs/${encodeURIComponent(target.scope.split("/").at(-2)!)}/labels`,
        page,
        ForgejoLabel,
        limit,
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
      target: IssueTarget,
      operation: string,
      path: string,
      cursor: string | undefined,
      viewer: string,
      canWrite?: boolean,
      active = true,
      order: IssueListOrder = "desc",
      expectedTotal?: number,
    ) {
      const state = yield* readCursor(target, "comments", cursor, order);
      const nativeCursor = state?.native;
      const offsetMatch = /^offset:(?:([1-9]\d{0,6}):)?([1-9]\d{0,8})$/.exec(nativeCursor ?? "");
      const pageMatch = COMMENT_PAGE_CURSOR.exec(nativeCursor ?? "");
      const page = offsetMatch
        ? Number(offsetMatch[1] ?? 1)
        : pageMatch
          ? Number(pageMatch[1])
          : parsePage(nativeCursor);
      if (page === null)
        return yield* refused(operation, "The cursor was not one Forgejo handed out.");
      const result = yield* request(target, operation, {
        path: `${path}/comments?limit=${PAGE_SIZE}&page=${page}`,
      });
      if (result.stdoutTruncated)
        return yield* refused(operation, "Forgejo response exceeded the output limit.");
      const decoded = decodeJsonResult(Schema.NullOr(Schema.Array(IssueCommentRecord)))(
        result.stdout,
      );
      if (Result.isFailure(decoded))
        return yield* refused(operation, "Forgejo returned an invalid response.", decoded.failure);
      const rows = decoded.success ?? [];
      const links = /^link:\s*(.*)$/im.exec(result.stderr)?.[1];
      const totals = [...result.stderr.matchAll(/^x-total-count:\s*([^\r\n]*)/gim)].map((match) =>
        match[1]!.trim(),
      );
      if (totals.length > 1 || (totals[0] !== undefined && !/^(0|[1-9]\d{0,8})$/.test(totals[0])))
        return yield* refused(operation, "Forgejo returned an invalid comment total.");
      const total = totals[0] === undefined ? (state?.total ?? expectedTotal) : Number(totals[0]);
      if (
        totals[0] !== undefined &&
        (total! < rows.length || (total === rows.length && /rel="?next"?/i.test(links ?? "")))
      )
        return yield* refused(operation, "Forgejo returned a contradictory comment total.");
      const complete = page === 1 && total === rows.length && !/rel="?next"?/i.test(links ?? "");
      if (state?.total !== undefined && (!complete || state.total !== total))
        return yield* refused(operation, "The Forgejo conversation changed. Refresh the comments.");
      if (order === "desc" && !complete && operation !== "getIssue")
        return yield* refused(
          operation,
          "This Forgejo response supports oldest-first comments only.",
        );
      const selectedOrder = complete ? order : "asc";
      const ordered = selectedOrder === "desc" ? rows.toReversed() : rows;
      const seenAt = pageMatch ? rows.findIndex((row) => row.id === Number(pageMatch[2])) : -1;
      const offset = offsetMatch ? Number(offsetMatch[2]) : seenAt + 1;
      if (offset > ordered.length || (offsetMatch && state?.lastId !== ordered[offset - 1]?.id))
        return yield* refused(
          operation,
          "The Forgejo comment offset is no longer valid. Refresh the conversation.",
        );
      const selected = ordered.slice(offset, offset + COMMENT_REACTION_LIMIT);
      if (
        new Set(rows.map((row) => row.id)).size !== rows.length ||
        (!offsetMatch &&
          state?.lastId !== undefined &&
          selected.some(
            (row) =>
              Date.parse(row.created_at) < Date.parse(state.lastAt ?? "") ||
              (Date.parse(row.created_at) === Date.parse(state.lastAt ?? "") &&
                row.id <= state.lastId!),
          ))
      )
        return yield* refused(operation, "Forgejo returned a repeated comment page.");
      const last = selected.at(-1);
      let nextCursor: string | null = null;
      if (last) {
        if (offset + selected.length < ordered.length)
          nextCursor = `offset:${page}:${offset + selected.length}`;
        else if (complete) nextCursor = null;
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
              editedAt:
                comment.updated_at && comment.updated_at !== comment.created_at
                  ? comment.updated_at
                  : null,
              ...(!active || canWrite !== undefined || comment.user?.login === viewer
                ? { canEdit: active && (canWrite === true || comment.user?.login === viewer) }
                : {}),
              reactions: forgejoReactions(reactions, viewer),
            })),
          ),
        { concurrency: 4 },
      );
      return {
        comments,
        nextCursor: yield* saveCursor(
          cursorIdentity(target, "comments", selectedOrder),
          nextCursor,
          last?.id,
          complete ? total : undefined,
          last?.created_at,
        ),
        commentOrders: complete ? undefined : (["asc"] as const),
      };
    });

    /** Pull requests the timeline shows citing this issue. */
    const linkedPullRequests = (
      target: Target,
      timeline: ReadonlyArray<typeof ForgejoTimelineEntry.Type>,
      issueUrl?: string,
    ): Effect.Effect<ReadonlyArray<IssueLinkedPullRequest>, IssueTrackerError> => {
      const currentMount = URL.parse(issueUrl ?? "")
        ?.pathname.match(/^(.*)\/[^/]+\/[^/]+\/issues\/[1-9]\d*\/?$/)?.[1]
        ?.replace(/^\//, "");
      const references = new Map<
        string,
        {
          readonly repository: string;
          readonly number: number;
          readonly closesIssue: boolean;
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
        const match = /^\/(.+)\/pulls\/([1-9]\d*)\/?$/.exec(url.pathname);
        if (
          !match ||
          !["http:", "https:"].includes(url.protocol) ||
          url.host.toLowerCase() !== target.host.toLowerCase() ||
          Number(match[2]) !== reference.number
        )
          continue;
        const repository = match[1]!;
        const mount = repository.split("/").slice(0, -2).join("/");
        references.set(`${repository}/${reference.number}`, {
          repository,
          number: reference.number,
          url: reference.html_url,
          mount,
          closesIssue:
            entry.ref_action === "closes" ||
            references.get(`${repository}/${reference.number}`)?.closesIssue === true,
        });
      }
      return Effect.forEach(
        [...references.values()],
        ({ repository, number, closesIssue, url, mount }) => {
          if (mount !== currentMount)
            return Effect.succeed<ReadonlyArray<IssueLinkedPullRequest>>([
              {
                repository,
                number,
                title: `#${number}`,
                url,
                state: null,
                isDraft: false,
                closesIssue,
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
                closesIssue,
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

    const scopedCommentPath = (input: IssueTarget, operation: string, commentId: string) =>
      Effect.gen(function* () {
        const { number } = yield* issueTarget(operation, input);
        if (!/^[1-9]\d*$/.test(commentId))
          return yield* refused(operation, "The comment id names no Forgejo comment.");
        const commentPath = `${repoPath(input.scope)}/issues/comments/${commentId}`;
        const comment = yield* read(
          input,
          operation,
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
          String(comment.id) !== commentId ||
          url === null ||
          !["http:", "https:"].includes(url.protocol) ||
          url.host.toLowerCase() !== input.host.toLowerCase() ||
          nativeScopePath?.toLowerCase() !== scopePath.toLowerCase() ||
          !ownerPath?.endsWith(issueSuffix) ||
          (mountPath !== "" &&
            ownerPath !== `/${mountPath}${issueSuffix}` &&
            ownerPath !== `/${mountPath}/api/v1/repos${issueSuffix}`)
        )
          return yield* refused(operation, "The comment does not belong to this issue.");
        return commentPath;
      });

    const pageInput = (input: Target & IssuePageInput, operation: string) => {
      const page = parsePage(input.cursor);
      return page === null
        ? Effect.fail(refused(operation, "The cursor was not one Forgejo handed out."))
        : Effect.succeed({ page, limit: Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE) });
    };

    const dependencyRepository = Effect.fn("ForgejoIssueTracker.dependencyRepository")(function* (
      input: Target,
      operation: string,
    ) {
      const scope = forgejoDependencyScope(input.scope);
      if (!scope) return yield* refused(operation, "Invalid Forgejo dependency scope.");
      const native = yield* cli
        .resolveRepository({ cwd: input.cwd, host: input.host, repository: input.scope })
        .pipe(
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
      const base = new URL(native.baseUrl);
      const mount = base.pathname.replace(/^\/|\/$/g, "");
      if (
        base.host.toLowerCase() !== input.host.toLowerCase() ||
        (scope.mount && scope.mount !== mount) ||
        native.repository.toLowerCase() !== scope.repository.toLowerCase()
      )
        return yield* refused(operation, "Forgejo resolved a different dependency scope.");
      return native;
    });

    const readDependency = Effect.fn("ForgejoIssueTracker.readDependency")(function* (
      input: Target & { readonly key: string },
      operation: string,
      baseUrl: string,
    ) {
      const { path } = yield* issueTarget(operation, input);
      const record = yield* read(input, operation, { path }, ForgejoDependencyIssue);
      const dependency = forgejoDependency(record, baseUrl);
      const scope = forgejoDependencyScope(input.scope);
      const actual =
        dependency && dependency !== "hidden" ? forgejoDependencyScope(dependency.scope) : null;
      if (
        !dependency ||
        dependency === "hidden" ||
        dependency.key !== input.key ||
        !actual ||
        !scope ||
        actual.repository.toLowerCase() !== scope.repository.toLowerCase()
      )
        return yield* refused(operation, "Forgejo returned a different dependency issue.");
      return dependency;
    });

    return {
      kind: KIND,
      capabilities: CAPABILITIES,

      getDependencies: (input) =>
        Effect.gen(function* () {
          const operation = "getDependencies";
          const match = /^([1-9]\d{0,6})(?::([1-9]\d?))?$/.exec(input.cursor ?? "1");
          if (!match || Number(match[2] ?? 0) >= PAGE_SIZE)
            return yield* refused(operation, "The cursor was not one Forgejo handed out.");
          const page = Number(match[1]);
          const offset = Number(match[2] ?? 0);
          const { number } = yield* issueTarget(operation, input);
          if (!Number.isSafeInteger(number)) return yield* notFound(operation);
          const native = yield* dependencyRepository(input, operation);
          const endpoint = input.direction === "blocks" ? "blocks" : "dependencies";
          const path = `${issuePath(native.repository, number)}/${endpoint}`;
          const result = yield* request(input, operation, {
            path: `${path}?limit=${PAGE_SIZE}&page=${page}`,
          });
          if (result.stdoutTruncated || result.stderrTruncated)
            return yield* refused(operation, "Forgejo response exceeded the output limit.");
          const decoded = decodeJsonResult(Schema.NullOr(Schema.Array(ForgejoDependencyIssue)))(
            result.stdout,
          );
          if (Result.isFailure(decoded))
            return yield* refused(
              operation,
              "Forgejo returned invalid dependencies.",
              decoded.failure,
            );
          const rows = decoded.success ?? [];
          if (rows.length > PAGE_SIZE || offset > rows.length)
            return yield* refused(operation, "Forgejo returned an invalid dependency page.");
          const pagination = forgejoDependencyPagination(
            result.stderr,
            new URL(`${native.baseUrl}/api/v1/${path}`),
            page,
            rows.length,
          );
          if (!pagination)
            return yield* refused(operation, "Forgejo returned invalid dependency pagination.");
          const items: IssueDependency[] = [];
          let hidden = false;
          let consumed = offset;
          for (let index = 0; index < rows.length; index++) {
            const dependency = forgejoDependency(rows[index]!, native.baseUrl);
            if (!dependency)
              return yield* refused(operation, "Forgejo returned an invalid dependency issue.");
            if (dependency === "hidden") hidden = true;
            if (index < offset || items.length >= Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE))
              continue;
            consumed = index + 1;
            if (dependency !== "hidden") items.push(dependency);
          }
          return {
            items,
            nextCursor:
              consumed < rows.length
                ? `${page}:${consumed}`
                : pagination.more && page < 9_999_999
                  ? String(page + 1)
                  : null,
            truncated: hidden || !pagination.known || (pagination.more && page === 9_999_999),
          };
        }),

      setDependency: (input) =>
        Effect.gen(function* () {
          const operation = "setDependency";
          const source = forgejoDependencyScope(input.scope);
          const target = forgejoDependencyScope(input.targetScope);
          const number = parseNumber(input.key);
          const targetNumber = parseNumber(input.targetKey);
          if (
            !source ||
            !target ||
            (source.mount && source.mount !== target.mount) ||
            number === null ||
            !Number.isSafeInteger(number) ||
            targetNumber === null ||
            !Number.isSafeInteger(targetNumber)
          )
            return yield* refused(
              operation,
              "Invalid Forgejo dependency target. No edge was changed.",
            );
          const native = yield* dependencyRepository(input, operation);
          if (
            target.mount &&
            target.mount !== new URL(native.baseUrl).pathname.replace(/^\/|\/$/g, "")
          )
            return yield* refused(
              operation,
              "The dependency target belongs to a different native mount. No edge was changed.",
            );
          const sourceRepository = yield* getRepository(input, operation);
          const sourceIssue = yield* readDependency(input, operation, native.baseUrl);
          const targetInput = { ...input, scope: input.targetScope, key: input.targetKey };
          const sameRepository =
            source.repository.toLowerCase() === target.repository.toLowerCase();
          const targetRepository = sameRepository
            ? sourceRepository
            : yield* getRepository(targetInput, operation);
          const targetIssue = yield* readDependency(targetInput, operation, native.baseUrl);
          const blockedRepository =
            input.direction === "blocks" ? targetRepository : sourceRepository;
          const blockedIssue = input.direction === "blocks" ? targetIssue : sourceIssue;
          if (
            sourceRepository.full_name.toLowerCase() !== source.repository.toLowerCase() ||
            targetRepository.full_name.toLowerCase() !== target.repository.toLowerCase() ||
            sourceIssue.kind !== "issue" ||
            sourceRepository.archived ||
            sourceRepository.has_issues === false ||
            blockedRepository.archived ||
            blockedRepository.internal_tracker?.enable_issue_dependencies === false ||
            (blockedIssue.kind === "issue"
              ? blockedRepository.has_issues === false
              : blockedRepository.has_pull_requests === false)
          )
            return yield* refused(
              operation,
              "The native repository does not allow this dependency. No edge was changed.",
            );
          yield* write(input, operation, {
            path: `${issuePath(input.scope, number)}/${input.direction === "blocks" ? "blocks" : "dependencies"}`,
            method: input.linked ? "POST" : "DELETE",
            body: { owner: target.owner, repo: target.repo, index: targetNumber },
          });
        }),

      getViewer: (input) => getViewer({ ...input, scope: "" }, "getViewer"),

      listIssues: (input) => {
        if (
          (input.sort !== undefined && input.sort !== "created") ||
          (input.order !== undefined && input.order !== "desc")
        )
          return Effect.fail(
            refused("listIssues", "Forgejo supports newest-created issues first."),
          );
        const page = parsePage(input.cursor);
        if (page === null) {
          return Effect.fail(refused("listIssues", "The cursor was not one Forgejo handed out."));
        }
        const open =
          input.stateCategories === undefined
            ? input.state !== "closed"
            : input.stateCategories.includes("unstarted");
        const closed =
          input.stateCategories === undefined
            ? input.state !== "open"
            : input.stateCategories.includes("completed");
        if (!open && !closed) return Effect.succeed({ items: [], nextCursor: null });
        const params = new URLSearchParams({
          type: "issues",
          state: open && closed ? "all" : open ? "open" : "closed",
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
                repository.permissions?.push ?? false,
                !repository.archived && repository.has_issues !== false,
                "desc",
                issue.comments,
              ),
              linkedPullRequests(input, timeline.rows, issue.html_url),
            ]).pipe(
              Effect.map(([conversation, links]) => ({
                ...forgejoIssue(issue),
                capabilities: {
                  ...CAPABILITIES,
                  ...(conversation.commentOrders === undefined
                    ? {}
                    : { commentOrders: conversation.commentOrders }),
                },
                body: issue.body ?? "",
                viewer,
                viewerPermissions: permissions(repository),
                reactions: forgejoReactions(reactions.rows, viewer),
                reactionsTruncated: !reactions.paginationKnown || reactions.nextCursor !== null,
                comments: conversation.comments,
                commentsCursor: conversation.nextCursor,
                events: timeline.rows.flatMap((entry) => forgejoIssueEvent(entry) ?? []),
                linkedPullRequests: links,
                historyTruncated: true,
              })),
            ),
          ),
        ),

      getComments: (input) =>
        issueTarget("getComments", input).pipe(
          Effect.flatMap(({ path }) =>
            commentsPage(
              input,
              "getComments",
              path,
              input.cursor,
              input.viewer ?? "",
              undefined,
              true,
              input.order,
            ),
          ),
        ),

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
        !CAPABILITIES.states.some((state) => state.name === input.state)
          ? Effect.fail(refused("setState", "Forgejo supports only the open and closed states."))
          : issueTarget("setState", input).pipe(
              Effect.flatMap(({ path }) =>
                write(input, "setState", { path, method: "PATCH", body: { state: input.state } }),
              ),
            ),

      setReaction: (input) =>
        Effect.gen(function* () {
          const { path } = yield* issueTarget("setReaction", input);
          let reactionPath = `${path}/reactions`;
          if (input.subjectId !== undefined) {
            const commentPath = yield* scopedCommentPath(input, "setReaction", input.subjectId);
            reactionPath = `${commentPath}/reactions`;
          }
          yield* write(input, "setReaction", {
            path: reactionPath,
            method: input.reacted ? "POST" : "DELETE",
            body: { content: FORGEJO_REACTIONS[input.content] },
          });
        }),

      editComment: (input) =>
        scopedCommentPath(input, "editComment", input.commentId).pipe(
          Effect.flatMap((path) =>
            write(input, "editComment", { path, method: "PATCH", body: { body: input.body } }),
          ),
        ),

      getHistory: (input) =>
        Effect.gen(function* () {
          const order = input.order ?? "desc";
          if (order !== "asc")
            return yield* refused(
              "getHistory",
              "Forgejo supports oldest-first issue history only.",
            );
          const { path } = yield* issueTarget("getHistory", input);
          const state = yield* readCursor(
            input,
            "history",
            input.cursor,
            order,
            input.limit ?? PAGE_SIZE,
          );
          const { page, limit } = yield* pageInput(
            { ...input, cursor: state?.native },
            "getHistory",
          );
          const rows = yield* readPage(
            input,
            "getHistory",
            `${path}/timeline`,
            page,
            ForgejoTimelineEntry,
            limit,
          );
          if (
            new Set(rows.rows.map((row) => row.id)).size !== rows.rows.length ||
            rows.rows.length > limit ||
            (state?.lastId !== undefined &&
              rows.rows.some(
                (row) =>
                  Date.parse(row.created_at) < Date.parse(state.lastAt ?? "") ||
                  (Date.parse(row.created_at) === Date.parse(state.lastAt ?? "") &&
                    row.id <= state.lastId!),
              ))
          )
            return yield* refused(
              "getHistory",
              "Forgejo returned a repeated or invalid history page.",
            );
          return {
            items: rows.rows.flatMap((row): IssueEvent[] =>
              row.type === "comment"
                ? []
                : [
                    forgejoIssueEvent(row) ?? {
                      id: String(row.id),
                      kind: "updated",
                      actor: forgejoActor(row.user),
                      createdAt: row.created_at,
                      detail: row.body?.trim() || row.type.replaceAll("_", " "),
                      ...forgejoIssueEventLinks(row),
                    },
                  ],
            ),
            nextCursor: yield* saveCursor(
              cursorIdentity(input, "history", order, input.limit ?? PAGE_SIZE),
              rows.nextCursor,
              rows.rows.at(-1)?.id,
              undefined,
              rows.rows.at(-1)?.created_at,
            ),
            truncated: true,
          };
        }),

      getLinkedPullRequests: (input) =>
        Effect.gen(function* () {
          const { path } = yield* issueTarget("getLinkedPullRequests", input);
          const { page, limit } = yield* pageInput(input, "getLinkedPullRequests");
          const rows = yield* readPage(
            input,
            "getLinkedPullRequests",
            `${path}/timeline`,
            page,
            ForgejoTimelineEntry,
            limit,
          );
          return {
            items: yield* linkedPullRequests(input, rows.rows),
            nextCursor: rows.nextCursor,
            truncated: !rows.paginationKnown,
          };
        }),

      listLabelCandidates: (input) =>
        Effect.gen(function* () {
          const match = /^(repo|org):([1-9]\d{0,6})$/.exec(input.cursor ?? "repo:1");
          if (match === null)
            return yield* refused(
              "listLabelCandidates",
              "The cursor was not one Forgejo handed out.",
            );
          const limit = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
          const page = Number(match[2]);
          const org = match[1] === "org";
          const rows = yield* org
            ? organizationLabels(input, "listLabelCandidates", page, limit)
            : readPage(
                input,
                "listLabelCandidates",
                `${repoPath(input.scope)}/labels`,
                page,
                ForgejoLabel,
                limit,
              );
          return {
            items: rows.rows.map((label) => ({
              id: `forgejo-label:${label.id}`,
              name: label.name,
              color: label.color ?? null,
              description: label.description ?? null,
            })),
            nextCursor:
              rows.nextCursor === null
                ? org
                  ? null
                  : "org:1"
                : `${org ? "org" : "repo"}:${rows.nextCursor}`,
            truncated: !rows.paginationKnown,
          };
        }),

      listAssigneeCandidates: (input) =>
        Effect.gen(function* () {
          const { page, limit } = yield* pageInput(input, "listAssigneeCandidates");
          const rows = yield* readPage(
            input,
            "listAssigneeCandidates",
            `${repoPath(input.scope)}/assignees`,
            page,
            ForgejoUser,
            limit,
          );
          return {
            items: rows.rows.flatMap((user) => {
              const actor = forgejoActor(user);
              return actor === null ? [] : [{ ...actor, id: actor.login }];
            }),
            nextCursor: rows.nextCursor,
            truncated: !rows.paginationKnown,
          };
        }),

      listTemplates: (input) =>
        Effect.all(
          [
            readWithRepository(
              input,
              "listTemplates",
              { path: `${repoPath(input.scope)}/issue_templates` },
              Schema.NullOr(Schema.Array(ForgejoIssueTemplate)),
            ),
            // A repository with no config leaves the blank issue where Forgejo puts it.
            read(
              input,
              "listTemplates",
              { path: `${repoPath(input.scope)}/issue_config` },
              ForgejoIssueConfig,
            ).pipe(
              Effect.map((config) => ({
                blankIssuesEnabled: config.blank_issues_enabled !== false,
                contactLinks: (config.contact_links ?? []).filter(
                  ({ url }) =>
                    URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol),
                ),
              })),
              Effect.catchIf(
                (error) => error.reason === "not-found" || error.reason === "failed",
                () => Effect.succeed({ blankIssuesEnabled: true, contactLinks: [] }),
              ),
            ),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.flatMap(([{ value: templates, repositoryUrl }, config]) => {
            const converted = (templates ?? []).map((template) => ({
              template,
              editable: forgejoIssueTemplate(template),
            }));
            const external = converted.filter(
              ({ template, editable }) => editable === null && /\.ya?ml$/i.test(template.file_name),
            );
            if (external.length > 0 && repositoryUrl === undefined)
              return Effect.fail(
                refused(
                  "listTemplates",
                  "Forgejo did not return the resolved repository URL for its native forms.",
                ),
              );
            const externalTemplates = external.map(({ template }) => {
              const url = new URL(`${repositoryUrl}/issues/new`);
              url.searchParams.set("template", template.file_name);
              return {
                name: template.name?.trim() || template.file_name,
                about: template.about ?? "",
                url: url.href,
              };
            });
            return Effect.succeed({
              templates: converted.flatMap(({ editable }) => editable ?? []),
              ...(externalTemplates.length === 0 ? {} : { externalTemplates }),
              blankIssuesEnabled: config.blankIssuesEnabled,
              ...(config.contactLinks.length === 0 ? {} : { contactLinks: config.contactLinks }),
            });
          }),
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
                  rows.findIndex((candidate) => candidate.id === label.id) === index,
              )
              .map((label) => ({
                id: `forgejo-label:${label.id}`,
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
