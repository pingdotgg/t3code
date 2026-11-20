/**
 * Forgejo's change requests, over its v1 REST API.
 *
 * Sits on `ForgejoApi.request` for credentials and transport, the way the Bitbucket reader sits
 * on `BitbucketApi.request`, and hands the provider above contract-shaped values. Gitea speaks
 * the same API, so one reader serves both.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerKind,
  PullRequestUpdateMethod,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";

import { ForgejoTransport } from "./ForgejoTransport.ts";
import * as Json from "./forgejoPullRequestJson.ts";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestActivity,
  ProviderChangeRequestDetail,
  ProviderChangeRequestPage,
  ProviderDiffFileContents,
  ProviderDiffSlice,
  ProviderListCursor,
} from "@t3tools/source-control-core/server/PullRequestProvider";

/** Forgejo's own ceiling on a page, so asking for more than this gains nothing. */
const MAX_PAGE_SIZE = 50;
/** A patch past this comes back cut short, so one huge change request cannot exhaust the server. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** A file past this is not worth expanding inline. */
const MAX_FILE_BYTES = 1024 * 1024;
/** How many conversation pages one read will walk before reporting the rest as unread. */
const MAX_CONVERSATION_PAGES = 10;

export class ForgejoPullRequestApiError extends Schema.TaggedError<ForgejoPullRequestApiError>()(
  "ForgejoPullRequestApiError",
  {
    operation: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Forgejo failed in ${this.operation}: ${this.detail}`;
  }
}

export interface ForgejoTarget {
  readonly cwd: string;
  readonly host: string;
  /** `owner/repo`, exactly as the project recorded it. */
  readonly repository: string;
}

export interface ForgejoChangeRequestTarget extends ForgejoTarget {
  readonly number: number;
}

/**
 * A conversation's identity, which Forgejo does not give one.
 *
 * A line note carries a file and a position, and notes sharing both are one conversation — which
 * is how Forgejo's own page groups them. That pair is therefore the id, so a reply can be placed
 * back on the same line without the host having to remember a thread for us.
 */
export function encodeThreadId(input: {
  readonly path: string;
  readonly position: number | null;
}): string {
  return `${input.position ?? 0}:${input.path}`;
}

export function decodeThreadId(
  threadId: string,
): { readonly path: string; readonly position: number | null } | null {
  const separator = threadId.indexOf(":");
  if (separator <= 0) return null;
  const position = Number(threadId.slice(0, separator));
  const path = threadId.slice(separator + 1);
  if (path.length === 0 || !Number.isSafeInteger(position) || position < 0) return null;
  return { path, position: position > 0 ? position : null };
}

/** `issue-comment:123` and `review-comment:123` as the conversation carried them. */
function decodeCommentId(
  commentId: string,
): { readonly kind: "issue-comment" | "review-comment"; readonly id: number } | null {
  const separator = commentId.indexOf(":");
  if (separator <= 0) return null;
  const kind = commentId.slice(0, separator);
  const id = Number(commentId.slice(separator + 1));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (kind !== "issue-comment" && kind !== "review-comment") return null;
  return { kind, id };
}

function splitRepository(
  repository: string,
): { readonly owner: string; readonly repo: string } | null {
  const parts = repository.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

function repositoryPath(
  repository: string,
  operation: string,
): Effect.Effect<string, ForgejoPullRequestApiError> {
  const parts = splitRepository(repository);
  return parts === null
    ? Effect.fail(
        new ForgejoPullRequestApiError({
          operation,
          detail: `Forgejo repositories are addressed as owner/repository; got "${repository}".`,
        }),
      )
    : Effect.succeed(`/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}`);
}

export interface ForgejoPullRequestApiShape {
  /** `host` is optional: without one the instance is read from the checkout's own remote. */
  readonly getViewer: (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
  }) => Effect.Effect<string, ForgejoPullRequestApiError>;
  readonly listChangeRequests: (
    input: ForgejoTarget & {
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
    },
  ) => Effect.Effect<ProviderChangeRequestPage, ForgejoPullRequestApiError>;
  readonly getChangeRequest: (
    input: ForgejoChangeRequestTarget,
  ) => Effect.Effect<ProviderChangeRequestDetail, ForgejoPullRequestApiError>;
  readonly getChangeRequestActivity: (
    input: ForgejoChangeRequestTarget & { readonly viewer: string | null },
  ) => Effect.Effect<ProviderChangeRequestActivity, ForgejoPullRequestApiError>;
  readonly getViewerPermissions: (
    input: ForgejoChangeRequestTarget,
  ) => Effect.Effect<PullRequestViewerPermissions, ForgejoPullRequestApiError>;
  readonly getDiff: (
    input: ForgejoChangeRequestTarget & { readonly commit?: string | undefined },
  ) => Effect.Effect<ProviderDiffSlice, ForgejoPullRequestApiError>;
  readonly getDiffFileContents: (
    input: ForgejoChangeRequestTarget & {
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    },
  ) => Effect.Effect<ProviderDiffFileContents, ForgejoPullRequestApiError>;
  readonly runAction: (
    input: ForgejoChangeRequestTarget & {
      readonly action: PullRequestAction;
      readonly mergeMethod?: PullRequestMergeMethod;
      readonly updateMethod?: PullRequestUpdateMethod;
    },
  ) => Effect.Effect<void, ForgejoPullRequestApiError>;
  readonly updateChangeRequest: (
    input: ForgejoChangeRequestTarget & {
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    },
  ) => Effect.Effect<void, ForgejoPullRequestApiError>;
  readonly comment: (
    input: ForgejoChangeRequestTarget & { readonly body: string },
  ) => Effect.Effect<void, ForgejoPullRequestApiError>;
  readonly updateComment: (
    input: ForgejoChangeRequestTarget & {
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    },
  ) => Effect.Effect<void, ForgejoPullRequestApiError>;
  readonly submitReview: (
    input: ForgejoChangeRequestTarget & {
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    },
  ) => Effect.Effect<void, ForgejoPullRequestApiError>;
  readonly replyToThread: (
    input: ForgejoChangeRequestTarget & {
      readonly threadId: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, ForgejoPullRequestApiError>;
  readonly listReviewerCandidates: (input: ForgejoChangeRequestTarget) => Effect.Effect<
    {
      readonly candidates: ReadonlyArray<{
        readonly login: string;
        readonly name: string | null;
        readonly avatarUrl: string | null;
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
        readonly isRequested: boolean;
      }>;
      readonly truncated: boolean;
    },
    ForgejoPullRequestApiError
  >;
  readonly setReviewerRequest: (
    input: ForgejoChangeRequestTarget & {
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      readonly requested: boolean;
    },
  ) => Effect.Effect<void, ForgejoPullRequestApiError>;
  readonly setReaction: (
    input: ForgejoChangeRequestTarget & {
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    },
  ) => Effect.Effect<void, ForgejoPullRequestApiError>;
}

export class ForgejoPullRequestApi extends Context.Service<
  ForgejoPullRequestApi,
  ForgejoPullRequestApiShape
>()("@t3tools/source-control-forgejo/server/ForgejoPullRequestApi") {}

const make = Effect.gen(function* () {
  const forgejo = yield* ForgejoTransport;

  const send = (input: {
    readonly operation: string;
    readonly method: "GET" | "POST" | "PATCH" | "DELETE";
    readonly host: string;
    readonly cwd: string;
    readonly path: string;
    readonly body?: unknown;
    readonly accept?: string;
    readonly maxBytes?: number;
  }) =>
    forgejo
      .request({
        operation: input.operation,
        method: input.method,
        host: input.host,
        cwd: input.cwd,
        path: input.path,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(input.accept === undefined ? {} : { accept: input.accept }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ForgejoPullRequestApiError({
              operation: input.operation,
              detail: cause.detail,
              ...(cause.status === undefined ? {} : { status: cause.status }),
              cause,
            }),
        ),
      );

  /** A read whose body must parse, since a page cannot be drawn from a payload we cannot read. */
  const read = <A>(
    input: Parameters<typeof send>[0] & {
      readonly decode: (body: string) => Result.Result<A, unknown>;
    },
  ): Effect.Effect<A, ForgejoPullRequestApiError> =>
    send(input).pipe(
      Effect.flatMap((response) => {
        const decoded = input.decode(response.body);
        if (!Result.isSuccess(decoded)) {
          return Effect.annotateCurrentSpan({
            "forgejo.decode": "failed",
            "forgejo.detail": String(decoded.failure).slice(0, 500),
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ForgejoPullRequestApiError({
                  operation: input.operation,
                  detail: "Forgejo returned a payload this could not read.",
                  cause: decoded.failure,
                }),
              ),
            ),
          );
        }
        const value = decoded.success;
        return Effect.annotateCurrentSpan({
          "forgejo.rows": Array.isArray(value) ? value.length : -1,
          "forgejo.bytes": response.body.length,
        }).pipe(Effect.as(value));
      }),
      // Spans are how this server reports itself; a read that answers nothing is otherwise
      // indistinguishable from one that was never made.
      Effect.withSpan(`ForgejoPullRequestApi.${input.operation}`, {
        attributes: { "forgejo.path": input.path },
      }),
    );

  const viewerByHost = new Map<string, string>();

  const resolveHost = (input: { readonly cwd: string; readonly host?: string | undefined }) =>
    input.host !== undefined && input.host.trim().length > 0
      ? Effect.succeed(input.host)
      : forgejo.resolveLocator({ cwd: input.cwd }).pipe(
          Effect.map((locator) => locator.host),
          Effect.mapError(
            (cause) =>
              new ForgejoPullRequestApiError({
                operation: "getViewer",
                detail: cause.detail,
                cause,
              }),
          ),
        );

  const getViewer: ForgejoPullRequestApiShape["getViewer"] = Effect.fn(
    "ForgejoPullRequestApi.getViewer",
  )((input) =>
    Effect.gen(function* () {
      const host = yield* resolveHost(input);
      const cached = viewerByHost.get(host);
      if (cached !== undefined) return cached;
      return yield* read({
        operation: "getViewer",
        method: "GET",
        host,
        cwd: input.cwd,
        path: "/user",
        decode: Json.decodeForgejoUser,
      }).pipe(
        Effect.flatMap((user) => {
          const login = (user.login ?? "").trim();
          return login.length === 0
            ? Effect.fail(
                new ForgejoPullRequestApiError({
                  operation: "getViewer",
                  detail: "Forgejo did not name the signed-in account.",
                }),
              )
            : Effect.succeed(login);
        }),
        Effect.tap((login) => Effect.sync(() => viewerByHost.set(host, login))),
      );
    }),
  );

  /**
   * Forgejo has `open`, `closed` and `all`, and treats a merged change request as closed. A
   * request for one of those two halves therefore asks for `closed` and keeps its half.
   */
  const hostState = (state: PullRequestListState): "open" | "closed" | "all" =>
    state === "open" ? "open" : state === "all" ? "all" : "closed";

  const keepForState = (state: PullRequestListState, merged: boolean): boolean =>
    state === "merged" ? merged : state === "closed" ? !merged : true;

  const readRepository = (input: ForgejoTarget, operation: string) =>
    repositoryPath(input.repository, operation).pipe(
      Effect.flatMap((base) =>
        read({
          operation,
          method: "GET",
          host: input.host,
          cwd: input.cwd,
          path: base,
          decode: Json.decodeForgejoRepository,
        }),
      ),
    );

  const readChecks = (
    input: ForgejoTarget & { readonly sha: string; readonly operation: string },
  ): Effect.Effect<ReadonlyArray<PullRequestCheck>, ForgejoPullRequestApiError> =>
    input.sha.trim().length === 0
      ? Effect.succeed([])
      : repositoryPath(input.repository, input.operation).pipe(
          Effect.flatMap((base) =>
            read({
              operation: input.operation,
              method: "GET",
              host: input.host,
              cwd: input.cwd,
              path: `${base}/commits/${encodeURIComponent(input.sha)}/statuses?limit=${MAX_PAGE_SIZE}`,
              decode: Json.decodeForgejoCommitStatusList,
            }),
          ),
          Effect.map(Json.normalizeChecks),
          // A repository with no CI answers 404 here, which is not a reason to fail the detail.
          Effect.orElseSucceed(() => [] as ReadonlyArray<PullRequestCheck>),
        );

  const listChangeRequests: ForgejoPullRequestApiShape["listChangeRequests"] = Effect.fn(
    "ForgejoPullRequestApi.listChangeRequests",
  )((input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "listChangeRequests");
      const pageSize = Math.min(Math.max(input.limit, 1), MAX_PAGE_SIZE);
      // Forgejo pages by number rather than by instant, so the count already handed over says
      // where to carry on from.
      const page = Math.floor((input.cursor?.delivered ?? 0) / pageSize) + 1;
      const query = new URLSearchParams({
        state: hostState(input.state),
        sort: "recentupdate",
        page: String(page),
        limit: String(pageSize),
      });
      // `poster` is the only involvement Forgejo's own listing narrows by; a review request is
      // matched against the rows below, which is a narrower answer rather than a wrong one.
      if (input.involvement === "authored" && input.viewer.trim().length > 0) {
        query.set("poster", input.viewer);
      }
      const rows = yield* read({
        operation: "listChangeRequests",
        method: "GET",
        host: input.host,
        cwd: input.cwd,
        path: `${base}/pulls?${query.toString()}`,
        decode: Json.decodeForgejoPullRequestList,
      });

      const viewer = input.viewer.trim().toLowerCase();
      const items: Array<ProviderChangeRequest> = [];
      for (const row of rows) {
        if (!keepForState(input.state, row.merged === true)) continue;
        const item = Json.normalizeChangeRequest(row);
        if (
          input.involvement === "reviewing" &&
          viewer.length > 0 &&
          !item.reviewRequestLogins.some((login) => login.toLowerCase() === viewer)
        ) {
          continue;
        }
        // `/pulls` takes no text filter, so narrow here over the title and description `q` would
        // search, within the fetched page. Forgejo's cross-repository search returns issues with
        // no head or base branch, so it cannot list change requests.
        const needle = input.query?.trim().toLowerCase() ?? "";
        if (
          needle.length > 0 &&
          !`${row.title ?? ""}\n${row.body ?? ""}`.toLowerCase().includes(needle)
        ) {
          continue;
        }
        items.push(item);
      }

      yield* Effect.annotateCurrentSpan({
        "forgejo.repository": input.repository,
        "forgejo.state": input.state,
        "forgejo.involvement": input.involvement,
        "forgejo.raw": rows.length,
        "forgejo.kept": items.length,
      });
      return {
        items,
        truncated: rows.length >= pageSize,
        // Rows dropped above were still consumed from the host's page, so the cursor has to
        // count them or the next page starts on top of ones already read past.
        cursorAdvance: rows.length,
        continues: true,
      } satisfies ProviderChangeRequestPage;
    }).pipe(Effect.withSpan("ForgejoPullRequestApi.listChangeRequests")),
  );

  /**
   * What this account may do, from the one thing Forgejo says about it: whether it can write.
   * Read access alone still leaves every conversation open, since Forgejo takes a comment from
   * anyone who can see the repository.
   */
  const viewerPermissionsFrom = (
    repository: typeof Json.ForgejoRepositorySchema.Type,
    writable: boolean,
  ): PullRequestViewerPermissions => ({
    actions: writable
      ? ([
          "merge",
          "close",
          "reopen",
          "ready",
          "draft",
          "update-branch",
          "enable-auto-merge",
          "disable-auto-merge",
        ] as const)
      : [],
    comment: true,
    // No endpoint marks a Forgejo conversation resolved, so nobody may.
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
    requestReviewers: writable,
    ...(repository.allow_rebase_update === false
      ? { updateMethods: writable ? (["merge"] as const) : [] }
      : { updateMethods: writable ? (["merge", "rebase"] as const) : [] }),
  });

  const getChangeRequest: ForgejoPullRequestApiShape["getChangeRequest"] = Effect.fn(
    "ForgejoPullRequestApi.getChangeRequest",
  )((input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "getChangeRequest");
      const [pullRequest, repository] = yield* Effect.all(
        [
          read({
            operation: "getChangeRequest",
            method: "GET",
            host: input.host,
            cwd: input.cwd,
            path: `${base}/pulls/${input.number}`,
            decode: Json.decodeForgejoPullRequest,
          }),
          readRepository(input, "getChangeRequest"),
        ],
        { concurrency: 2 },
      );
      const checks = yield* readChecks({
        ...input,
        sha: pullRequest.head?.sha ?? "",
        operation: "getChangeRequest",
      });

      const writable = Json.canWrite(repository);
      const core = Json.normalizeChangeRequest(pullRequest);
      return {
        ...core,
        body: pullRequest.body ?? "",
        changedFiles: typeof pullRequest.changed_files === "number" ? pullRequest.changed_files : 0,
        mergedAt: pullRequest.merged_at ? Json.isoOrEpoch(pullRequest.merged_at) : null,
        closedAt: pullRequest.closed_at ? Json.isoOrEpoch(pullRequest.closed_at) : null,
        reviewers: (pullRequest.requested_reviewers ?? []).flatMap(
          (reviewer) => Json.normalizeActor(reviewer) ?? [],
        ),
        checks,
        ...(checks.length > 0 ? { checksState: Json.rollupChecksState(checks) } : {}),
        mergeCapabilities: Json.normalizeMergeCapabilities(repository),
        viewerPermissions: viewerPermissionsFrom(repository, writable),
      } satisfies ProviderChangeRequestDetail;
    }),
  );

  const getViewerPermissions: ForgejoPullRequestApiShape["getViewerPermissions"] = (input) =>
    readRepository(input, "getViewerPermissions").pipe(
      Effect.map((repository) => viewerPermissionsFrom(repository, Json.canWrite(repository))),
    );

  /** One page of anything Forgejo pages by number, walked until it runs out or the cap is hit. */
  const readAllPages = <A>(input: {
    readonly operation: string;
    readonly host: string;
    readonly cwd: string;
    readonly path: string;
    readonly decode: (body: string) => Result.Result<ReadonlyArray<A>, unknown>;
  }): Effect.Effect<
    { readonly items: ReadonlyArray<A>; readonly truncated: boolean },
    ForgejoPullRequestApiError
  > => {
    const step = (
      page: number,
      collected: ReadonlyArray<A>,
    ): Effect.Effect<
      { readonly items: ReadonlyArray<A>; readonly truncated: boolean },
      ForgejoPullRequestApiError
    > =>
      read({
        operation: input.operation,
        method: "GET",
        host: input.host,
        cwd: input.cwd,
        path: `${input.path}${input.path.includes("?") ? "&" : "?"}page=${page}&limit=${MAX_PAGE_SIZE}`,
        decode: input.decode,
      }).pipe(
        Effect.flatMap((rows) => {
          const items = [...collected, ...rows];
          if (rows.length < MAX_PAGE_SIZE) return Effect.succeed({ items, truncated: false });
          if (page >= MAX_CONVERSATION_PAGES) return Effect.succeed({ items, truncated: true });
          return step(page + 1, items);
        }),
      );
    return step(1, []);
  };

  const getChangeRequestActivity: ForgejoPullRequestApiShape["getChangeRequestActivity"] =
    Effect.fn("ForgejoPullRequestApi.getChangeRequestActivity")((input) =>
      Effect.gen(function* () {
        const base = yield* repositoryPath(input.repository, "getChangeRequestActivity");
        const [comments, reviews, commits] = yield* Effect.all(
          [
            readAllPages({
              operation: "getChangeRequestActivity",
              host: input.host,
              cwd: input.cwd,
              path: `${base}/issues/${input.number}/comments`,
              decode: Json.decodeForgejoCommentList,
            }),
            readAllPages({
              operation: "getChangeRequestActivity",
              host: input.host,
              cwd: input.cwd,
              path: `${base}/pulls/${input.number}/reviews`,
              decode: Json.decodeForgejoReviewList,
            }),
            readAllPages({
              operation: "getChangeRequestActivity",
              host: input.host,
              cwd: input.cwd,
              path: `${base}/pulls/${input.number}/commits`,
              decode: Json.decodeForgejoCommitList,
            }).pipe(
              // A change request whose head has gone leaves no commits to read; the conversation
              // is still worth showing.
              Effect.orElseSucceed(() => ({ items: [], truncated: false })),
            ),
          ],
          { concurrency: 3 },
        );

        // Every line note lives under a review, so the notes are collected from the reviews rather
        // than from an endpoint of their own, which Forgejo does not have.
        const reviewComments = yield* Effect.forEach(
          reviews.items,
          (review) =>
            read({
              operation: "getChangeRequestActivity",
              method: "GET",
              host: input.host,
              cwd: input.cwd,
              path: `${base}/pulls/${input.number}/reviews/${review.id}/comments`,
              decode: Json.decodeForgejoReviewCommentList,
            }).pipe(
              Effect.orElseSucceed(
                () => [] as ReadonlyArray<typeof Json.ForgejoReviewCommentSchema.Type>,
              ),
            ),
          { concurrency: 4 },
        );

        const issueReactions = yield* read({
          operation: "getChangeRequestActivity",
          method: "GET",
          host: input.host,
          cwd: input.cwd,
          path: `${base}/issues/${input.number}/reactions`,
          decode: Json.decodeForgejoReactionList,
        }).pipe(Effect.orElseSucceed(() => []));

        const commentReactions = yield* Effect.forEach(
          comments.items,
          (comment) =>
            read({
              operation: "getChangeRequestActivity",
              method: "GET",
              host: input.host,
              cwd: input.cwd,
              path: `${base}/issues/comments/${comment.id}/reactions`,
              decode: Json.decodeForgejoReactionList,
            }).pipe(
              Effect.map(
                (rows) => [comment.id, Json.normalizeReactions(rows, input.viewer)] as const,
              ),
              Effect.orElseSucceed(
                () => [comment.id, [] as ReadonlyArray<PullRequestReaction>] as const,
              ),
            ),
          { concurrency: 4 },
        );
        const reactionsByComment = new Map(commentReactions);

        const conversation: Array<PullRequestComment> = [];
        for (const comment of comments.items) {
          conversation.push(
            Json.normalizeIssueComment(comment, reactionsByComment.get(comment.id) ?? []),
          );
        }
        for (const review of reviews.items) {
          const entry = Json.normalizeReview(review);
          if (entry !== null) conversation.push(entry);
        }
        conversation.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

        const commitEntries: Array<PullRequestCommit> = [];
        for (const commit of commits.items) {
          const entry = Json.normalizeCommit(commit);
          if (entry !== null) commitEntries.push(entry);
        }

        const threads: ReadonlyArray<PullRequestReviewThread> = Json.normalizeReviewThreads(
          reviewComments.flat(),
        );

        return {
          comments: conversation,
          commentCount: conversation.length,
          commentsTruncated: comments.truncated || reviews.truncated,
          reviewThreads: threads.map((thread) => ({
            ...thread,
            id: encodeThreadId({ path: thread.path, position: thread.line }),
          })),
          commits: commitEntries,
          reactions: Json.normalizeReactions(issueReactions, input.viewer),
        } satisfies ProviderChangeRequestActivity;
      }),
    );

  const getDiff: ForgejoPullRequestApiShape["getDiff"] = Effect.fn("ForgejoPullRequestApi.getDiff")(
    (input) =>
      Effect.gen(function* () {
        const base = yield* repositoryPath(input.repository, "getDiff");
        const path =
          input.commit === undefined
            ? `${base}/pulls/${input.number}.diff`
            : `${base}/git/commits/${encodeURIComponent(input.commit)}.diff`;
        const response = yield* send({
          operation: "getDiff",
          method: "GET",
          host: input.host,
          cwd: input.cwd,
          path,
          accept: "text/plain",
          maxBytes: MAX_DIFF_BYTES,
        });
        return {
          patch: response.body,
          truncated: response.truncated,
          // Forgejo serves a whole patch in one response, so there is never a next slice.
          nextCursor: null,
        } satisfies ProviderDiffSlice;
      }),
  );

  const readFileAt = (input: {
    readonly base: string;
    readonly host: string;
    readonly cwd: string;
    readonly path: string;
    readonly ref: string;
  }) =>
    read({
      operation: "getDiffFileContents",
      method: "GET",
      host: input.host,
      cwd: input.cwd,
      path: `${input.base}/contents/${input.path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}?ref=${encodeURIComponent(input.ref)}`,
      maxBytes: MAX_FILE_BYTES,
      decode: Json.decodeForgejoContents,
    }).pipe(
      Effect.map((contents) => {
        const encoded = contents.content ?? "";
        if ((contents.encoding ?? "") !== "base64" || encoded.length === 0) return "";
        try {
          return Buffer.from(encoded, "base64").toString("utf8");
        } catch {
          return "";
        }
      }),
      // A path missing on one side is an empty file there, which is what a new or deleted file is.
      Effect.orElseSucceed(() => ""),
    );

  const getDiffFileContents: ForgejoPullRequestApiShape["getDiffFileContents"] = Effect.fn(
    "ForgejoPullRequestApi.getDiffFileContents",
  )((input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "getDiffFileContents");
      const pullRequest = yield* read({
        operation: "getDiffFileContents",
        method: "GET",
        host: input.host,
        cwd: input.cwd,
        path: `${base}/pulls/${input.number}`,
        decode: Json.decodeForgejoPullRequest,
      });
      const baseSha = (pullRequest.base?.sha ?? "").trim();
      const headSha = (pullRequest.head?.sha ?? "").trim();
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new" || baseSha.length === 0
            ? Effect.succeed("")
            : readFileAt({
                base,
                host: input.host,
                cwd: input.cwd,
                path: input.oldPath,
                ref: baseSha,
              }),
          input.changeType === "deleted" || headSha.length === 0
            ? Effect.succeed("")
            : readFileAt({
                base,
                host: input.host,
                cwd: input.cwd,
                path: input.newPath,
                ref: headSha,
              }),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents } satisfies ProviderDiffFileContents;
    }),
  );

  const FORGEJO_MERGE_STYLE: Record<PullRequestMergeMethod, string> = {
    merge: "merge",
    squash: "squash",
    rebase: "rebase",
    "fast-forward": "fast-forward-only",
  };

  const runAction: ForgejoPullRequestApiShape["runAction"] = Effect.fn(
    "ForgejoPullRequestApi.runAction",
  )((input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "runAction");
      const pullRequest = `${base}/pulls/${input.number}`;
      switch (input.action) {
        case "merge":
          yield* send({
            operation: "runAction.merge",
            method: "POST",
            host: input.host,
            cwd: input.cwd,
            path: `${pullRequest}/merge`,
            body: { Do: FORGEJO_MERGE_STYLE[input.mergeMethod ?? "merge"] },
          });
          return;
        case "enable-auto-merge":
          yield* send({
            operation: "runAction.enableAutoMerge",
            method: "POST",
            host: input.host,
            cwd: input.cwd,
            path: `${pullRequest}/merge`,
            body: {
              Do: FORGEJO_MERGE_STYLE[input.mergeMethod ?? "merge"],
              merge_when_checks_succeed: true,
            },
          });
          return;
        case "disable-auto-merge":
          yield* send({
            operation: "runAction.disableAutoMerge",
            method: "DELETE",
            host: input.host,
            cwd: input.cwd,
            path: `${pullRequest}/merge`,
          });
          return;
        case "close":
        case "reopen":
          yield* send({
            operation: `runAction.${input.action}`,
            method: "PATCH",
            host: input.host,
            cwd: input.cwd,
            path: pullRequest,
            body: { state: input.action === "close" ? "closed" : "open" },
          });
          return;
        case "update-branch":
          yield* send({
            operation: "runAction.updateBranch",
            method: "POST",
            host: input.host,
            cwd: input.cwd,
            path: `${pullRequest}/update?style=${input.updateMethod ?? "merge"}`,
          });
          return;
        case "ready":
        case "draft": {
          // Forgejo has no draft flag to set: a change request is a draft while its title carries
          // the work-in-progress prefix, so the title is what moves.
          const current = yield* read({
            operation: `runAction.${input.action}`,
            method: "GET",
            host: input.host,
            cwd: input.cwd,
            path: pullRequest,
            decode: Json.decodeForgejoPullRequest,
          });
          const title = (current.title ?? "").trim();
          const stripped = title.replace(WIP_PREFIX_PATTERN, "").trim();
          yield* send({
            operation: `runAction.${input.action}`,
            method: "PATCH",
            host: input.host,
            cwd: input.cwd,
            path: pullRequest,
            body: { title: input.action === "draft" ? `WIP: ${stripped}` : stripped },
          });
          return;
        }
      }
    }),
  );

  const updateChangeRequest: ForgejoPullRequestApiShape["updateChangeRequest"] = (input) =>
    repositoryPath(input.repository, "updateChangeRequest").pipe(
      Effect.flatMap((base) =>
        send({
          operation: "updateChangeRequest",
          method: "PATCH",
          host: input.host,
          cwd: input.cwd,
          path: `${base}/pulls/${input.number}`,
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        }),
      ),
      Effect.asVoid,
    );

  const comment: ForgejoPullRequestApiShape["comment"] = (input) =>
    repositoryPath(input.repository, "comment").pipe(
      Effect.flatMap((base) =>
        send({
          operation: "comment",
          method: "POST",
          host: input.host,
          cwd: input.cwd,
          path: `${base}/issues/${input.number}/comments`,
          body: { body: input.body },
        }),
      ),
      Effect.asVoid,
    );

  const updateComment: ForgejoPullRequestApiShape["updateComment"] = Effect.fn(
    "ForgejoPullRequestApi.updateComment",
  )((input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "updateComment");
      const decoded = decodeCommentId(input.commentId);
      if (decoded === null) {
        return yield* new ForgejoPullRequestApiError({
          operation: "updateComment",
          detail: "That remark carries no id this can address.",
        });
      }
      // Forgejo stores a line note as a comment like any other, so both kinds are rewritten
      // through the same route.
      yield* send({
        operation: "updateComment",
        method: "PATCH",
        host: input.host,
        cwd: input.cwd,
        path: `${base}/issues/comments/${decoded.id}`,
        body: { body: input.body },
      });
    }),
  );

  const VERDICT_EVENT: Record<PullRequestReviewVerdict, string> = {
    comment: "COMMENT",
    approve: "APPROVED",
    "request-changes": "REQUEST_CHANGES",
  };

  const reviewCommentBody = (draft: PullRequestReviewCommentDraft) => ({
    path: draft.path,
    body: draft.body,
    ...(draft.position.kind === "deleted"
      ? { old_position: draft.position.oldLine }
      : { new_position: draft.position.newLine }),
  });

  const submitReview: ForgejoPullRequestApiShape["submitReview"] = (input) =>
    repositoryPath(input.repository, "submitReview").pipe(
      Effect.flatMap((base) =>
        send({
          operation: "submitReview",
          method: "POST",
          host: input.host,
          cwd: input.cwd,
          path: `${base}/pulls/${input.number}/reviews`,
          body: {
            event: VERDICT_EVENT[input.verdict],
            body: input.body,
            comments: input.comments.map(reviewCommentBody),
          },
        }),
      ),
      Effect.asVoid,
    );

  const replyToThread: ForgejoPullRequestApiShape["replyToThread"] = Effect.fn(
    "ForgejoPullRequestApi.replyToThread",
  )((input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "replyToThread");
      const thread = decodeThreadId(input.threadId);
      if (thread === null) {
        return yield* new ForgejoPullRequestApiError({
          operation: "replyToThread",
          detail: "That conversation carries no position this can reply against.",
        });
      }
      // A reply is a new note on the same line, which is what puts it in the same conversation
      // once the notes are grouped again.
      yield* send({
        operation: "replyToThread",
        method: "POST",
        host: input.host,
        cwd: input.cwd,
        path: `${base}/pulls/${input.number}/reviews`,
        body: {
          event: "COMMENT",
          body: "",
          comments: [
            {
              path: thread.path,
              body: input.body,
              ...(thread.position === null ? {} : { new_position: thread.position }),
            },
          ],
        },
      });
    }),
  );

  const listReviewerCandidates: ForgejoPullRequestApiShape["listReviewerCandidates"] = Effect.fn(
    "ForgejoPullRequestApi.listReviewerCandidates",
  )((input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "listReviewerCandidates");
      const [people, pullRequest] = yield* Effect.all(
        [
          read({
            operation: "listReviewerCandidates",
            method: "GET",
            host: input.host,
            cwd: input.cwd,
            path: `${base}/reviewers`,
            decode: Json.decodeForgejoUserList,
          }),
          read({
            operation: "listReviewerCandidates",
            method: "GET",
            host: input.host,
            cwd: input.cwd,
            path: `${base}/pulls/${input.number}`,
            decode: Json.decodeForgejoPullRequest,
          }),
        ],
        { concurrency: 2 },
      );

      const author = (pullRequest.user?.login ?? "").trim().toLowerCase();
      const requested = new Set(
        (pullRequest.requested_reviewers ?? [])
          .map((reviewer) => (reviewer?.login ?? "").trim().toLowerCase())
          .filter((login) => login.length > 0),
      );

      const candidates = [];
      for (const person of people) {
        const actor = Json.normalizeActor(person);
        // Nobody reviews their own change request, so the author is not offered.
        if (actor === null || actor.login.toLowerCase() === author) continue;
        candidates.push({
          ...actor,
          // Forgejo asks for a reviewer by login, so the handle is also the address.
          id: actor.login,
          kind: "user" as const,
          isRequested: requested.has(actor.login.toLowerCase()),
        });
      }
      return { candidates, truncated: false };
    }),
  );

  const setReviewerRequest: ForgejoPullRequestApiShape["setReviewerRequest"] = (input) =>
    repositoryPath(input.repository, "setReviewerRequest").pipe(
      Effect.flatMap((base) =>
        send({
          operation: "setReviewerRequest",
          method: input.requested ? "POST" : "DELETE",
          host: input.host,
          cwd: input.cwd,
          path: `${base}/pulls/${input.number}/requested_reviewers`,
          body: {
            reviewers: input.reviewers
              .filter((reviewer) => reviewer.kind === "user")
              .map((reviewer) => reviewer.id),
            team_reviewers: input.reviewers
              .filter((reviewer) => reviewer.kind === "team")
              .map((reviewer) => reviewer.id),
          },
        }),
      ),
      Effect.asVoid,
    );

  const setReaction: ForgejoPullRequestApiShape["setReaction"] = Effect.fn(
    "ForgejoPullRequestApi.setReaction",
  )((input) =>
    Effect.gen(function* () {
      const base = yield* repositoryPath(input.repository, "setReaction");
      // No subject is the change request itself, whose reactions sit on its description.
      const subject =
        input.subjectId === undefined
          ? `${base}/issues/${input.number}/reactions`
          : (() => {
              const decoded = decodeCommentId(input.subjectId);
              return decoded === null ? null : `${base}/issues/comments/${decoded.id}/reactions`;
            })();
      if (subject === null) {
        return yield* new ForgejoPullRequestApiError({
          operation: "setReaction",
          detail: "That remark carries no id this can address.",
        });
      }
      yield* send({
        operation: "setReaction",
        method: input.reacted ? "POST" : "DELETE",
        host: input.host,
        cwd: input.cwd,
        path: subject,
        body: { content: Json.forgejoReactionName(input.content) },
      });
    }),
  );

  return ForgejoPullRequestApi.of({
    getViewer,
    listChangeRequests,
    getChangeRequest,
    getChangeRequestActivity,
    getViewerPermissions,
    getDiff,
    getDiffFileContents,
    runAction,
    updateChangeRequest,
    comment,
    updateComment,
    submitReview,
    replyToThread,
    listReviewerCandidates,
    setReviewerRequest,
    setReaction,
  });
});

/**
 * Forgejo's default work-in-progress markers. An instance may configure its own; a change request
 * marked with one of those keeps its prefix when it is made ready, which is visible and
 * correctable rather than silent.
 */
const WIP_PREFIX_PATTERN = /^(?:\[WIP\]|WIP:|WIP)\s*/iu;

export const layer = Layer.effect(ForgejoPullRequestApi, make);
