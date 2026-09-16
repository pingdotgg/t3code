import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { ForgejoCli, type ForgejoApiInput } from "../sourceControl/ForgejoCli.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequestDetail,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import {
  ForgejoPullRequest,
  ForgejoRepository,
  ForgejoUser,
  ForgejoComment,
  ForgejoReview,
  ForgejoReviewComment,
  ForgejoCommit,
  ForgejoStatus,
  ForgejoLabel,
  ForgejoReaction,
  FORGEJO_REACTIONS,
  forgejoChangeRequest,
  forgejoActor,
  forgejoComment,
  forgejoReview,
  forgejoReviewThread,
  forgejoCommit,
  forgejoChecks,
  forgejoReactions,
} from "./forgejoPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: ["merge", "close", "reopen", "update-branch"],
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: ["merge", "rebase"],
  search: false,
  reactions: true,
  labels: true,
  // Forgejo's public API has no thread replies/resolution or draft conversion endpoint.
  review: {
    inlineComment: true,
    reply: false,
    resolve: false,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};
const repoPath = (input: ProviderRepositoryRef) =>
  `repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
const pullPath = (input: ProviderRepositoryRef & { readonly number: number }) =>
  `${repoPath(input)}/pulls/${input.number}`;
const issuePath = (input: ProviderRepositoryRef & { readonly number: number }) =>
  `${repoPath(input)}/issues/${input.number}`;
// Review IDs differ from the issue-comment IDs used by Forgejo's reactions API.
const reviewCommentId = (review: typeof ForgejoReview.Type) =>
  /#issuecomment-([1-9]\d*)$/.exec(review.html_url ?? "")?.[1];

export const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: "forgejo",
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const request = (input: ForgejoApiInput) =>
    cli.api(input).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: "forgejo",
            operation: input.path,
            detail: error.detail,
            cause: error,
            reason:
              error.reason === "missing-cli"
                ? "missing-tool"
                : error.reason === "authentication"
                  ? "unauthenticated"
                  : error.reason === "rate-limit"
                    ? "rate-limited"
                    : "failed",
          }),
      ),
    );
  const read = Effect.fn("ForgejoPullRequestProvider.read")(function* <A>(
    input: ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    const result = yield* request(input);
    if (result.stdoutTruncated)
      return yield* failure(input.path, "Forgejo response exceeded the output limit.");
    const decoded = decodeJsonResult(schema)(result.stdout);
    return Result.isSuccess(decoded)
      ? decoded.success
      : yield* failure(input.path, "Forgejo returned an invalid response.", decoded.failure);
  });
  const readArray = <A>(input: ForgejoApiInput, schema: Schema.Codec<A, unknown, never, never>) =>
    read(input, Schema.NullOr(Schema.Array(schema))).pipe(Effect.map((rows) => rows ?? []));
  const readPage = Effect.fn("ForgejoPullRequestProvider.readPage")(function* <A>(
    input: ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
    index: number,
  ) {
    const result = yield* request({
      ...input,
      path: `${input.path}${input.path.includes("?") ? "&" : "?"}limit=50&page=${index}`,
    });
    if (result.stdoutTruncated)
      return yield* failure(input.path, "Forgejo response exceeded the output limit.");
    const decoded = decodeJsonResult(Schema.NullOr(Schema.Array(schema)))(result.stdout);
    if (Result.isFailure(decoded))
      return yield* failure(input.path, "Forgejo returned an invalid response.", decoded.failure);
    const rows = decoded.success ?? [];
    const links = /^link:\s*(.*)$/im.exec(result.stderr)?.[1];
    return {
      rows,
      more: rows.length > 0 && (links === undefined || /rel="?next"?/i.test(links)),
    };
  });
  // Use a stable, small page size that also works with Forgejo's default maximum of 50.
  const page = Effect.fn("ForgejoPullRequestProvider.page")(function* <A>(
    input: ForgejoApiInput,
    schema: Schema.Codec<A, unknown, never, never>,
    limit = 500,
  ) {
    const items: A[] = [];
    for (let index = 1; items.length < limit; index++) {
      const { rows, more } = yield* readPage(input, schema, index);
      items.push(...rows);
      if (!more) return { items, truncated: false };
    }
    return { items, truncated: true };
  });
  const write = (input: ForgejoApiInput) => request(input).pipe(Effect.asVoid);
  const getPull = (input: ProviderRepositoryRef & { readonly number: number }) =>
    read(
      {
        cwd: input.cwd,
        repository: input.repository,
        host: input.host,
        path: pullPath(input),
      },
      ForgejoPullRequest,
    );
  const getRepo = (input: ProviderRepositoryRef) =>
    read({ ...input, path: repoPath(input) }, ForgejoRepository);
  const getViewer = (input: {
    readonly cwd: string;
    readonly repository?: string;
    readonly host?: string;
  }) => read({ ...input, path: "user" }, ForgejoUser).pipe(Effect.map((user) => user.login));
  const permissions = (
    repo: typeof ForgejoRepository.Type,
    pr: typeof ForgejoPullRequest.Type,
    viewer: string,
  ): PullRequestViewerPermissions => {
    const canWrite = repo.permissions?.push ?? false;
    const canEdit = canWrite || pr.user?.login === viewer;
    const active = !repo.archived;
    return {
      actions: active
        ? CAPABILITIES.actions.filter((action) =>
            action === "merge" || action === "update-branch" ? canWrite : canEdit,
          )
        : [],
      comment: active && (!pr.is_locked || canWrite),
      resolve: false,
      verdicts: active
        ? pr.user?.login === viewer
          ? ["comment"]
          : CAPABILITIES.review.verdicts
        : [],
      requestReviewers: active && canEdit,
      labels: active && canWrite,
      updateMethods:
        active && canWrite ? (repo.allow_rebase_update ? ["merge", "rebase"] : ["merge"]) : [],
    };
  };
  const getPermissions = Effect.fn("ForgejoPullRequestProvider.getPermissions")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const [repo, pr, viewer] = yield* Effect.all(
      [getRepo(input), getPull(input), getViewer(input)],
      { concurrency: 3 },
    );
    return permissions(repo, pr, viewer);
  });
  const unsupported = (operation: string) =>
    Effect.fail(failure(operation, `Forgejo does not expose ${operation} through its API.`));
  const provider: PullRequestProviderApi = {
    kind: "forgejo",
    capabilities: CAPABILITIES,
    getViewer,
    listChangeRequests: Effect.fn("ForgejoPullRequestProvider.listChangeRequests")(
      function* (input) {
        const offset = input.cursor?.delivered ?? 0;
        const items: ReturnType<typeof forgejoChangeRequest>[] = [];
        const state = input.state === "merged" ? "closed" : input.state;
        const query = {
          ...input,
          path: `${repoPath(input)}/pulls?state=${state}&sort=recentupdate`,
        };
        // Self-hosted servers may cap pages below 50. Establish their actual page size before
        // translating the service's row offset into an API page number.
        const first = yield* readPage(query, Schema.NullOr(ForgejoPullRequest), 1);
        const pageSize = first.rows.length || 50;
        const firstIndex = Math.floor(offset / pageSize) + 1;
        let consumed = 0;
        let more = true;
        for (let index = firstIndex; more && consumed < input.limit; index++) {
          const result =
            index === 1 ? first : yield* readPage(query, Schema.NullOr(ForgejoPullRequest), index);
          const rows = result.rows;
          const start = index === firstIndex ? offset % pageSize : 0;
          const countBefore = consumed;
          for (const row of rows.slice(start)) {
            if (consumed >= input.limit) break;
            consumed++;
            if (row) items.push(forgejoChangeRequest(row));
          }
          more = result.more || rows.length - start > consumed - countBefore;
        }
        return { items, truncated: more, continues: true, cursorAdvance: consumed };
      },
    ),
    getChangeRequestSummary: (input) => getPull(input).pipe(Effect.map(forgejoChangeRequest)),
    getChangeRequest: Effect.fn("ForgejoPullRequestProvider.getChangeRequest")(function* (input) {
      const [pr, repo, viewer] = yield* Effect.all(
        [getPull(input), getRepo(input), getViewer(input)],
        { concurrency: 3 },
      );
      const statuses = yield* page(
        {
          ...input,
          path: `${repoPath(input)}/statuses/${encodeURIComponent(pr.head.sha)}?sort=recentupdate`,
        },
        ForgejoStatus,
      );
      return {
        ...forgejoChangeRequest(pr),
        body: pr.body ?? "",
        changedFiles: pr.changed_files ?? 0,
        reviewers: (pr.requested_reviewers ?? []).flatMap((user) => {
          const actor = forgejoActor(user);
          return actor ? [actor] : [];
        }),
        checks: forgejoChecks(statuses.items),
        baseComparison: !pr.merge_base
          ? "unknown"
          : pr.merge_base === pr.base.sha
            ? "up-to-date"
            : "behind",
        viewerPermissions: permissions(repo, pr, viewer),
        mergeCapabilities: {
          merge: repo.allow_merge_commits ?? true,
          squash: repo.allow_squash_merge ?? true,
          rebase: repo.allow_rebase ?? true,
        },
      } satisfies ProviderChangeRequestDetail;
    }),
    getViewerPermissions: getPermissions,
    getChangeRequestActivity: Effect.fn("ForgejoPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const [comments, reviews, commits, reactions, viewer] = yield* Effect.all(
          [
            // Issue comments ignore page/limit; fetch this unpaginated endpoint once.
            readArray({ ...input, path: `${issuePath(input)}/comments` }, ForgejoComment).pipe(
              Effect.map((items) => ({
                items: items.slice(0, 500),
                truncated: items.length > 500,
              })),
            ),
            page({ ...input, path: `${pullPath(input)}/reviews` }, ForgejoReview),
            page({ ...input, path: `${pullPath(input)}/commits` }, ForgejoCommit),
            page({ ...input, path: `${issuePath(input)}/reactions` }, ForgejoReaction),
            getViewer(input),
          ],
          { concurrency: 5 },
        );
        const reviewComments = yield* Effect.forEach(
          reviews.items.filter((review) => review.comments_count > 0 && review.state !== "PENDING"),
          (review) =>
            readArray(
              { ...input, path: `${pullPath(input)}/reviews/${review.id}/comments` },
              ForgejoReviewComment,
            ),
          { concurrency: 4 },
        );
        const allInline = reviewComments.flat();
        const inline = allInline.slice(0, 500);
        const entries = [
          ...comments.items.map((comment) => ({
            comment: forgejoComment(comment),
            reactionId: String(comment.id),
          })),
          ...reviews.items
            .filter((review) => review.state !== "PENDING" && review.state !== "REQUEST_REVIEW")
            .map((review) => ({
              comment: forgejoReview(review),
              reactionId: reviewCommentId(review),
            })),
          ...inline.map((comment) => ({
            comment: {
              ...forgejoComment(comment),
              kind: "review-comment" as const,
              path: comment.path,
            },
            reactionId: String(comment.id),
          })),
        ];
        const enriched = yield* Effect.forEach(
          entries,
          ({ comment, reactionId }) =>
            (reactionId === undefined
              ? Effect.succeed([])
              : readArray(
                  { ...input, path: `${repoPath(input)}/issues/comments/${reactionId}/reactions` },
                  ForgejoReaction,
                )
            ).pipe(
              Effect.map((rows) => ({ ...comment, reactions: forgejoReactions(rows, viewer) })),
            ),
          { concurrency: 4 },
        );
        const byId = new Map(enriched.map((comment) => [comment.id, comment]));
        const timeline = enriched.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
        return {
          comments: timeline,
          commentCount: timeline.length,
          commentsTruncated:
            comments.truncated || reviews.truncated || allInline.length > inline.length,
          reviewThreads: inline.map((comment) => ({
            ...forgejoReviewThread(comment),
            comments: [byId.get(String(comment.id)) ?? forgejoComment(comment)],
          })),
          commits: commits.items.map(forgejoCommit),
          reactions: forgejoReactions(reactions.items, viewer),
        };
      },
    ),
    getDiff: (input) =>
      request({
        ...input,
        path: input.commit
          ? `${repoPath(input)}/git/commits/${encodeURIComponent(input.commit)}.diff`
          : `${pullPath(input)}.diff`,
      }).pipe(
        Effect.map((result) => ({
          patch: result.stdout,
          truncated: result.stdoutTruncated,
          nextCursor: null,
        })),
      ),
    getDiffFileContents: Effect.fn("ForgejoPullRequestProvider.getDiffFileContents")(
      function* (input) {
        const pr = yield* getPull(input);
        const commit = input.commit
          ? yield* read(
              {
                ...input,
                path: `${repoPath(input)}/git/commits/${encodeURIComponent(input.commit)}`,
              },
              ForgejoCommit,
            )
          : null;
        const oldRef = commit ? commit.parents[0]?.sha : pr.merge_base || pr.base.sha;
        const newRef = input.commit ?? pr.head.sha;
        const content = (repository: string, ref: string, path: string) =>
          read(
            {
              ...input,
              repository,
              path: `${repoPath({ ...input, repository })}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
            },
            Schema.Struct({ content: Schema.String, encoding: Schema.Literal("base64") }),
          ).pipe(Effect.map((file) => Buffer.from(file.content, "base64").toString("utf8")));
        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new" || !oldRef
              ? Effect.succeed("")
              : content(input.repository, oldRef, input.oldPath),
            input.changeType === "deleted"
              ? Effect.succeed("")
              : content(pr.head.repo?.full_name ?? input.repository, newRef, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      },
    ),
    runAction: (input) => {
      switch (input.action) {
        case "merge":
          return write({
            ...input,
            path: `${pullPath(input)}/merge`,
            method: "POST",
            body: { Do: input.mergeMethod ?? "merge" },
          });
        case "close":
        case "reopen":
          return write({
            ...input,
            path: pullPath(input),
            method: "PATCH",
            body: { state: input.action === "close" ? "closed" : "open" },
          });
        case "update-branch":
          return write({
            ...input,
            path: `${pullPath(input)}/update?style=${input.updateMethod ?? "merge"}`,
            method: "POST",
          });
        default:
          return unsupported(input.action);
      }
    },
    updateChangeRequest: (input) =>
      write({
        ...input,
        path: pullPath(input),
        method: "PATCH",
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        },
      }),
    comment: (input) =>
      write({
        ...input,
        path: `${issuePath(input)}/comments`,
        method: "POST",
        body: { body: input.body },
      }),
    updateComment: (input) =>
      write({
        ...input,
        path: `${repoPath(input)}/issues/comments/${encodeURIComponent(input.commentId)}`,
        method: "PATCH",
        body: { body: input.body },
      }),
    submitReview: Effect.fn("ForgejoPullRequestProvider.submitReview")(function* (input) {
      const pr = yield* getPull(input);
      yield* write({
        ...input,
        path: `${pullPath(input)}/reviews`,
        method: "POST",
        body: {
          event:
            input.verdict === "approve"
              ? "APPROVED"
              : input.verdict === "request-changes"
                ? "REQUEST_CHANGES"
                : "COMMENT",
          body: input.body,
          commit_id: pr.head.sha,
          comments: input.comments.map((comment) => {
            const position = comment.position;
            const old =
              position.kind === "deleted" ||
              (position.kind === "context" && position.side === "left");
            return {
              path: old ? (comment.oldPath ?? comment.path) : comment.path,
              body: comment.body,
              old_position: old ? position.oldLine : 0,
              new_position: old ? 0 : position.newLine,
            };
          }),
        },
      });
    }),
    listReviewerCandidates: Effect.fn("ForgejoPullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const [pr, users] = yield* Effect.all(
          [getPull(input), page({ ...input, path: `${repoPath(input)}/assignees` }, ForgejoUser)],
          { concurrency: 2 },
        );
        return {
          candidates: users.items
            .filter((user) => user.login !== pr.user?.login)
            .flatMap((user) => {
              const actor = forgejoActor(user);
              return actor
                ? [
                    {
                      ...actor,
                      id: user.login,
                      kind: "user" as const,
                      isRequested:
                        pr.requested_reviewers?.some((reviewer) => reviewer.login === user.login) ??
                        false,
                    },
                  ]
                : [];
            }),
          truncated: users.truncated,
        };
      },
    ),
    setReviewerRequest: (input) =>
      write({
        ...input,
        path: `${pullPath(input)}/requested_reviewers`,
        method: input.requested ? "POST" : "DELETE",
        body: { reviewers: input.reviewers.map((reviewer) => reviewer.id) },
      }),
    listLabelCandidates: Effect.fn("ForgejoPullRequestProvider.listLabelCandidates")(
      function* (input) {
        const [pr, labels] = yield* Effect.all(
          [getPull(input), page({ ...input, path: `${repoPath(input)}/labels` }, ForgejoLabel)],
          { concurrency: 2 },
        );
        return {
          candidates: labels.items.map((label) => ({
            name: label.name,
            color: label.color ?? null,
            description: label.description ?? null,
            isApplied: pr.labels?.some((applied) => applied.id === label.id) ?? false,
          })),
          truncated: labels.truncated,
        };
      },
    ),
    setLabels: Effect.fn("ForgejoPullRequestProvider.setLabels")(function* (input) {
      const labels = yield* page({ ...input, path: `${repoPath(input)}/labels` }, ForgejoLabel);
      const selected = labels.items.filter((label) => input.labels.includes(label.name));
      if (selected.length !== input.labels.length)
        return yield* failure("setLabels", "One or more requested labels could not be found.");
      if (input.applied)
        yield* write({
          ...input,
          path: `${issuePath(input)}/labels`,
          method: "POST",
          body: { labels: selected.map((label) => label.id) },
        });
      else
        yield* Effect.forEach(
          selected,
          (label) =>
            write({ ...input, path: `${issuePath(input)}/labels/${label.id}`, method: "DELETE" }),
          { concurrency: 1 },
        );
    }),
    setReaction: Effect.fn("ForgejoPullRequestProvider.setReaction")(function* (input) {
      let commentId = input.subjectId;
      if (commentId?.startsWith("review:")) {
        const reviewId = /^review:([1-9]\d*)$/.exec(commentId)?.[1];
        if (!reviewId) return yield* failure("setReaction", "Invalid Forgejo review ID.");
        const review = yield* read(
          { ...input, path: `${pullPath(input)}/reviews/${reviewId}` },
          ForgejoReview,
        );
        commentId = reviewCommentId(review);
        if (!commentId)
          return yield* failure(
            "setReaction",
            "Forgejo did not return a comment ID for this review.",
          );
      }
      if (commentId && !/^[1-9]\d*$/.test(commentId))
        return yield* failure("setReaction", "Invalid Forgejo comment ID.");
      yield* write({
        ...input,
        path: commentId
          ? `${repoPath(input)}/issues/comments/${commentId}/reactions`
          : `${issuePath(input)}/reactions`,
        method: input.reacted ? "POST" : "DELETE",
        body: { content: FORGEJO_REACTIONS[input.content] },
      });
    }),
    replyToThread: () => unsupported("thread replies"),
    setThreadResolution: () => unsupported("thread resolution"),
  };
  return provider;
});
