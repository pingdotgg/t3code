import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type PullRequestCapabilities,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";

import * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import * as Json from "./gitCafePullRequestJson.ts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";

// The deployed API requires versioned write receipts. Enable mutations after their
// request and completion semantics are mapped, independently of readable host data.
const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: false,
  actions: [],
  mergeMethods: [],
  search: true,
  stacks: true,
  stackActions: false,
  reactions: false,
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: false, comment: false },
};
const IdentitySchema = Schema.Struct({ user: Schema.Struct({ username: TrimmedNonEmptyString }) });
const FilterOptionsSchema = Schema.Struct({
  actors: Schema.Array(
    Schema.Struct({ actorId: TrimmedNonEmptyString, handle: TrimmedNonEmptyString }),
  ),
});
const encodeActorIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const DiffStatsSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      additions: Schema.optional(NonNegativeInt),
      deletions: Schema.optional(NonNegativeInt),
    }),
  ),
  truncated: Schema.Boolean,
});
const StatusSchema = Schema.Struct({
  merge: Schema.Struct({
    conflicts: Schema.Literals(["unknown", "conflicting"]),
    fastForward: Schema.NullOr(Schema.Boolean),
    strategies: Schema.Array(Schema.String),
  }),
  checks: Schema.Struct({
    pending: NonNegativeInt,
    failing: NonNegativeInt,
    successful: NonNegativeInt,
    total: NonNegativeInt,
  }),
});
const ChecksSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.Literals(["queued", "in_progress", "completed"]),
      conclusion: Schema.NullOr(Schema.String),
      summary: Schema.NullOr(Schema.String),
      detailsUrl: Schema.NullOr(Schema.String),
    }),
  ),
});
function checkStatus(check: (typeof ChecksSchema.Type.items)[number]) {
  if (check.status !== "completed") return "pending" as const;
  switch (check.conclusion) {
    case "success":
      return "success" as const;
    case "neutral":
      return "neutral" as const;
    case "skipped":
      return "skipped" as const;
    case "cancelled":
      return "cancelled" as const;
    case "action_required":
      return "action-required" as const;
    default:
      return "failure" as const;
  }
}
const isGitCafeCliError = Schema.is(GitCafeCli.GitCafeCliError);
const PAGE_SIZE = 100;
const CONVERSATION_PAGES = 10;

export function gitCafeProviderFailure(error: GitCafeCli.GitCafeCliError) {
  if (error.code === "CLI_UNAVAILABLE") return "missing-tool" as const;
  if (error.status === 401 || error.code === "AUTHENTICATION_REQUIRED")
    return "unauthenticated" as const;
  if (error.status === 429 || error.code === "RATE_LIMITED") return "rate-limited" as const;
  return "failed" as const;
}
export function gitCafeViewerPermissions(): PullRequestViewerPermissions {
  return {
    actions: [],
    stackRebase: false,
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const cli = yield* GitCafeCli.GitCafeCli;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: "gitcafe",
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const unsupported = (operation: string) =>
    Effect.fail(
      failure(
        operation,
        "GitCafe writes are not supported here yet. Open the pull request on GitCafe to make changes.",
      ),
    );
  const target = (input: ProviderRepositoryRef) =>
    (input.host === "git.cafe" || input.host === "staging.git.cafe") &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)
      ? Effect.succeed(
          `/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}/pulls`,
        )
      : Effect.fail(
          failure(
            "resolveRepository",
            "GitCafe supports repositories on git.cafe and staging.git.cafe addressed as owner/name.",
          ),
        );
  const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
    input: Pick<ProviderRepositoryRef, "cwd" | "host">,
    endpoint: string,
    schema: S,
    operation: string,
    maxOutputBytes?: number,
  ) =>
    cli
      .api({
        cwd: input.cwd,
        host: input.host,
        endpoint,
        ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new PullRequestProviderError({
              provider: "gitcafe",
              operation,
              reason: gitCafeProviderFailure(error),
              detail: error.detail,
              cause: error,
            }),
        ),
        Effect.flatMap((raw) =>
          Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
            Effect.mapError((cause) =>
              failure(operation, "GitCafe returned an unreadable response.", cause),
            ),
          ),
        ),
      );
  const readPull = Effect.fn("GitCafePullRequestProvider.readPull")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const base = yield* target(input);
    return yield* read(input, `${base}/${input.number}`, Json.PullDetailSchema, "getChangeRequest");
  });
  const readComments = Effect.fn("GitCafePullRequestProvider.readComments")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const base = yield* target(input);
    const items: Array<(typeof Json.CommentsSchema.Type.items)[number]> = [];
    let nextAfter: string | null = null;
    for (let page = 0; page < CONVERSATION_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (nextAfter !== null) query.set("after", nextAfter);
      const batch = yield* read(
        input,
        `${base}/${input.number}/comments?${query}`,
        Json.CommentsSchema,
        "listComments",
        8 * 1024 * 1024,
      );
      items.push(...batch.items);
      nextAfter = batch.nextAfter;
      if (nextAfter === null || batch.items.length === 0) break;
    }
    return { items, nextAfter };
  });
  const readReviews = Effect.fn("GitCafePullRequestProvider.readReviews")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const base = yield* target(input);
    const items: Array<(typeof Json.ReviewsSchema.Type.items)[number]> = [];
    let nextAfter: string | null = null;
    for (let page = 0; page < CONVERSATION_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (nextAfter !== null) query.set("after", nextAfter);
      const batch = yield* read(
        input,
        `${base}/${input.number}/reviews?${query}`,
        Json.ReviewsSchema,
        "listReviews",
        8 * 1024 * 1024,
      );
      items.push(...batch.items);
      const previous: string | null = nextAfter;
      nextAfter = batch.nextAfter;
      if (nextAfter === null || nextAfter === previous || batch.items.length === 0) break;
    }
    return { items, nextAfter };
  });
  const provider: PullRequestProviderApi = {
    kind: "gitcafe",
    capabilities: CAPABILITIES,
    getViewer: (input) =>
      read(
        { ...input, host: input.host ?? "git.cafe" },
        "/auth/identity",
        IdentitySchema,
        "getViewer",
      ).pipe(Effect.map((identity) => identity.user.username)),
    listChangeRequests: Effect.fn("GitCafePullRequestProvider.listChangeRequests")(
      function* (input) {
        const base = yield* target(input);
        let authorId: string | undefined;
        if (input.involvement === "authored" || input.involvement === "reviewing") {
          const options = yield* read(
            input,
            `${base}/filter-options`,
            FilterOptionsSchema,
            "listChangeRequestAuthors",
          );
          authorId = options.actors.find(
            (actor) => actor.handle.toLowerCase() === input.viewer.toLowerCase(),
          )?.actorId;
          if (authorId === undefined) return { items: [], truncated: false, continues: false };
        }
        const limit = Math.min(1000, Math.max(1, input.limit));
        const items: Array<Json.RawPull> = [];
        let nextAfter: string | null = null;
        do {
          const query = new URLSearchParams({
            limit: String(Math.min(PAGE_SIZE, limit - items.length)),
            sort: "newest",
          });
          if (input.state !== "all") query.set("state", input.state);
          if (input.query?.trim()) query.set("q", input.query.trim());
          if (authorId !== undefined)
            query.set(
              input.involvement === "reviewing" ? "reviewers" : "authors",
              encodeActorIds([authorId]),
            );
          if (nextAfter !== null) query.set("after", nextAfter);
          const batch = yield* read(
            input,
            `${base}?${query}`,
            Json.PullListSchema,
            "listChangeRequests",
          );
          items.push(...batch.items);
          nextAfter = batch.nextAfter;
          if (batch.items.length === 0) break;
        } while (nextAfter !== null && items.length < limit);
        return {
          items: items.map((pull) => {
            const item = Json.toChangeRequest(pull, input.repository, input.host);
            return input.involvement === "reviewing"
              ? {
                  ...item,
                  reviewRequestLogins: [...new Set([...item.reviewRequestLogins, input.viewer])],
                }
              : item;
          }),
          truncated: nextAfter !== null,
          continues: false,
        };
      },
    ),
    getChangeRequestSummary: (input) =>
      readPull(input).pipe(
        Effect.map((pull) => ({
          ...Json.toChangeRequest(pull, input.repository, input.host),
          closedAt: pull.closedAt,
          mergedAt: pull.mergedAt,
        })),
      ),
    getChangeRequest: Effect.fn("GitCafePullRequestProvider.getChangeRequest")(function* (input) {
      const base = yield* target(input);
      const pull = yield* readPull(input);
      const [reviewers, status, changes, checks] = yield* Effect.all(
        [
          read(
            input,
            `${base}/${input.number}/reviewers?limit=100`,
            Json.ReviewersSchema,
            "listReviewers",
          ),
          read(input, `${base}/${input.number}/status`, StatusSchema, "getStatus"),
          pull.headOid === null
            ? Effect.succeed(null)
            : read(
                input,
                `${base}/${input.number}/diff?expectedVersion=${pull.version}&limit=500`,
                DiffStatsSchema,
                "getChangeRequestStats",
                8 * 1024 * 1024,
              ).pipe(
                Effect.catch((error) => {
                  if (!isGitCafeCliError(error.cause)) return Effect.fail(error);
                  if (pull.state !== "open" && error.cause.status === 404)
                    return Effect.succeed(null);
                  // GC2 refuses detailed diffs beyond its native admission limits;
                  // the structural inventory still supplies the file count.
                  if (error.cause.status === 413 || error.cause.status === 501)
                    return read(
                      input,
                      `${base}/${input.number}/changes?expectedVersion=${pull.version}`,
                      DiffStatsSchema,
                      "getChangeRequestStats",
                    );
                  return Effect.fail(error);
                }),
              ),
          pull.headOid === null
            ? Effect.succeed(null)
            : read(
                input,
                `${base.slice(0, -6)}/commits/${encodeURIComponent(pull.headOid)}/checks`,
                ChecksSchema,
                "getChecks",
              ),
        ],
        { concurrency: 4 },
      );
      const actors = Json.toReviewers(reviewers, input.host);
      return {
        ...Json.toChangeRequest(pull, input.repository, input.host),
        body: pull.description ?? "",
        ...(pull.sourceRepo === null
          ? {}
          : { headRepositoryNameWithOwner: `${pull.sourceRepo.owner}/${pull.sourceRepo.name}` }),
        additions: changes?.items.reduce((total, file) => total + (file.additions ?? 0), 0) ?? 0,
        deletions: changes?.items.reduce((total, file) => total + (file.deletions ?? 0), 0) ?? 0,
        changedFiles: changes?.items.length ?? 0,
        closedAt: pull.closedAt,
        mergedAt: pull.mergedAt,
        reviewers: actors,
        reviewRequestLogins: actors.map((actor) => actor.login),
        checks:
          checks?.items.map((check) => ({
            name: check.name,
            status: checkStatus(check),
            description: check.summary,
            url: check.detailsUrl,
          })) ?? [],
        ...(status.checks.total === 0
          ? {}
          : {
              checksState:
                status.checks.failing > 0
                  ? ("failing" as const)
                  : status.checks.pending > 0
                    ? ("pending" as const)
                    : ("passing" as const),
            }),
        mergeability:
          status.merge.conflicts === "conflicting"
            ? ("conflicting" as const)
            : ("unknown" as const),
        baseComparison:
          status.merge.fastForward === null
            ? ("unknown" as const)
            : status.merge.fastForward
              ? ("up-to-date" as const)
              : ("behind" as const),
        mergeCapabilities: {
          merge: status.merge.strategies.includes("merge"),
          squash: status.merge.strategies.includes("squash"),
          rebase: status.merge.strategies.includes("rebase"),
        },
        viewerPermissions: gitCafeViewerPermissions(),
      };
    }),
    getChangeRequestStack: Effect.fn("GitCafePullRequestProvider.getChangeRequestStack")(
      function* (input) {
        const base = yield* target(input);
        const { stack } = yield* read(
          input,
          `${base}/${input.number}/stack`,
          Json.StackEnvelopeSchema,
          "getChangeRequestStack",
        );
        return stack === null ? null : Json.toStack(stack, input.repository, input.host);
      },
    ),
    getChangeRequestActivity: Effect.fn("GitCafePullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const pull = yield* readPull(input);
        const [comments, reviews, commits] = yield* Effect.all(
          [
            readComments(input),
            readReviews(input),
            pull.headOid === null
              ? Effect.succeed({ items: [], truncated: false, nextAfter: null, headOid: "" })
              : read(
                  input,
                  `${yield* target(input)}/${input.number}/commits?limit=100`,
                  Json.CommitListSchema,
                  "listCommits",
                ),
          ],
          { concurrency: 3 },
        );
        return Json.toActivity(comments, reviews, commits, pull.headOid ?? undefined, input.host);
      },
    ),
    getViewerPermissions: () => Effect.succeed(gitCafeViewerPermissions()),
    getDiff: Effect.fn("GitCafePullRequestProvider.getDiff")(function* (input) {
      if (input.cursor !== undefined)
        return yield* failure("getDiff", "GitCafe diffs do not support continuation cursors.");
      const base = yield* target(input);
      if (input.commit !== undefined) {
        const pull = yield* readPull(input);
        const repository =
          pull.sourceRepo === null
            ? input.repository
            : `${pull.sourceRepo.owner}/${pull.sourceRepo.name}`;
        const sourceBase = (yield* target({ ...input, repository })).slice(0, -6);
        const commitQuery = new URLSearchParams({ ref: "HEAD", oid: input.commit });
        const commit = yield* read(
          input,
          `${sourceBase}/commit?${commitQuery}`,
          Schema.Struct({ oid: Schema.String, parents: Schema.Array(Schema.String) }),
          "getDiff",
        );
        const parent = commit.parents[0];
        if (parent === undefined)
          return yield* failure(
            "getDiff",
            "GitCafe cannot compare a root commit yet. Open the commit on GitCafe to inspect it.",
          );
        const query = new URLSearchParams({
          base: "HEAD",
          baseOid: parent,
          head: "HEAD",
          headOid: commit.oid,
          limit: "500",
        });
        return Json.toDiff(
          yield* read(
            input,
            `${sourceBase}/compare?${query}`,
            Json.DiffSchema,
            "getDiff",
            8 * 1024 * 1024,
          ),
        );
      }
      return Json.toDiff(
        yield* read(
          input,
          `${base}/${input.number}/diff`,
          Json.DiffSchema,
          "getDiff",
          8 * 1024 * 1024,
        ),
      );
    }),
    runAction: () => unsupported("runAction"),
    comment: () => unsupported("comment"),
    submitReview: () => unsupported("submitReview"),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    replyToThread: () => unsupported("replyToThread"),
    setReaction: () => unsupported("setReaction"),
    setThreadResolution: () => unsupported("setThreadResolution"),
  };
  return provider;
});
