import { resolvePullRequestAuthorFilter, SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PullRequestCapabilities, PullRequestReviewerCandidate } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";

import * as OriginApi from "./OriginApi.ts";
import * as OriginHosts from "./originHosts.ts";
import * as Json from "./originPullRequestJson.ts";
import { definition } from "../shared/definition.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash"],
  search: true,
  stacks: true,
  stackActions: false,
  reactions: true,
  labels: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["approve", "request-changes", "comment"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "Origin needs the Origin CLI or CURSOR_AUTH_TOKEN / CURSOR_API_KEY on the server. Install with `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`, then `origin auth login`.",
  unauthenticated:
    "Origin rejected the configured credentials. Run `origin auth login`, or check CURSOR_AUTH_TOKEN / CURSOR_API_KEY in Settings → Source Control.",
};

const MIRROR_MESSAGE =
  "This Origin repository is a mirrored GitHub repository. Use the GitHub remote and GitHub provider for pull requests.";

const PAGE_SIZE = 100;
const VERDICT = {
  approve: "approve",
  "request-changes": "request_changes",
  comment: "comment",
} as const;

const decodeComments = Schema.decodeEffect(Schema.fromJsonString(Json.OriginComments));
const decodeReviews = Schema.decodeEffect(Schema.fromJsonString(Json.OriginReviews));
const decodeCommits = Schema.decodeEffect(Schema.fromJsonString(Json.OriginCommits));
const decodeLabels = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      labels: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          color: Schema.optional(Schema.String),
          description: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

type PullRef = ProviderRepositoryRef & { readonly number: number };

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* OriginApi.OriginApi;

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("origin"),
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const mapError = (operation: string) => (error: OriginApi.OriginApiError) =>
    new PullRequestProviderError({
      provider: SourceControlProviderKind.make("origin"),
      operation,
      reason: error.reason,
      detail: error.detail,
      cause: error,
    });

  const repositoryPath = (
    operation: string,
    input: ProviderRepositoryRef,
  ): Effect.Effect<string, PullRequestProviderError> => {
    const repository = OriginHosts.originRepositoryPath(input.repository);
    if (
      repository === input.repository &&
      (OriginHosts.isOriginRemoteHost(input.host) || OriginHosts.isOriginWebHost(input.host))
    )
      return Effect.succeed(`/repos/${repository}`);
    return Effect.fail(
      failure(
        operation,
        `Origin serves owner/name repositories on ${OriginHosts.ORIGIN_REMOTE_HOST} (remotes) and ${OriginHosts.ORIGIN_WEB_HOST} (pull requests).`,
      ),
    );
  };

  const send = (operation: string, request: Omit<OriginApi.OriginApiRequest, "operation">) =>
    api.request({ ...request, operation }).pipe(Effect.mapError(mapError(operation)));

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    request: Omit<OriginApi.OriginApiRequest, "operation">,
    schema: S,
  ) =>
    send(operation, request).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            failure(operation, "Origin returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  const requireNative = (operation: string, repository: string) =>
    read(operation, { path: `/repos/${repository}` }, Json.OriginRepo).pipe(
      Effect.filterOrFail(
        (repo) => repo.mirror == null,
        () => failure(operation, MIRROR_MESSAGE),
      ),
    );

  const pullPath = (operation: string, input: PullRef) =>
    repositoryPath(operation, input).pipe(Effect.map((base) => `${base}/pulls/${input.number}`));

  const readPull = (operation: string, input: PullRef) =>
    pullPath(operation, input).pipe(
      Effect.flatMap((path) => read(operation, { path }, Json.OriginPull)),
    );

  const readPages = Effect.fn("OriginPullRequestProvider.readPages")(function* <A>(
    operation: string,
    firstPath: string,
    decode: (
      raw: string,
    ) => Effect.Effect<{ items: ReadonlyArray<A>; next: string | null }, PullRequestProviderError>,
  ) {
    const items: Array<A> = [];
    let path = firstPath;
    for (let page = 0; page < 20; page++) {
      const batch = yield* send(operation, { path }).pipe(Effect.flatMap(decode));
      items.push(...batch.items);
      if (!batch.next) break;
      const url = new URL(path, "https://api.cursor.com");
      url.searchParams.set("pageToken", batch.next);
      path = `${url.pathname}${url.search}`;
    }
    return items;
  });

  const provider: PullRequestProviderApi = {
    kind: SourceControlProviderKind.make("origin"),
    capabilities: CAPABILITIES,
    servesHost: OriginHosts.isOriginServedHost,
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    readsPublicHostWithoutCheckout: true,

    getViewer: Effect.fn("OriginPullRequestProvider.getViewer")(function* () {
      const namespaces = yield* read(
        "getViewer",
        { path: "/namespaces?pageSize=1" },
        Json.OriginNamespaces,
      );
      return namespaces.namespaces[0]?.namespace.slug ?? "origin-user";
    }),

    listChangeRequests: Effect.fn("OriginPullRequestProvider.listChangeRequests")(
      function* (input) {
        yield* requireNative("listChangeRequests", input.repository);
        const query = new URLSearchParams({
          pageSize: String(Math.min(input.limit, PAGE_SIZE)),
          sortBy: "updated",
          state: input.state === "all" ? "all" : input.state,
        });
        if (input.cursor?.resumeAfter) query.set("pageToken", input.cursor.resumeAfter);
        if (input.query) {
          const search = yield* read(
            "listChangeRequests",
            {
              path: `/search/pulls?${new URLSearchParams({
                q: input.query,
                repo: input.repository,
                pageSize: String(Math.min(input.limit, PAGE_SIZE)),
                ...(input.cursor?.resumeAfter ? { pageToken: input.cursor.resumeAfter } : {}),
              })}`,
            },
            Json.OriginPulls,
          );
          return {
            items: search.pullRequests.map((pull) => Json.toChangeRequest(pull, input.repository)),
            truncated: Boolean(search.nextPageToken),
            continues: Boolean(search.nextPageToken),
            ...(search.nextPageToken ? { resumeAfter: search.nextPageToken } : {}),
          };
        }
        if (input.filters?.author !== undefined)
          query.set("author", resolvePullRequestAuthorFilter(input.filters.author, input.viewer));
        const page = yield* read(
          "listChangeRequests",
          { path: `/repos/${input.repository}/pulls?${query}` },
          Json.OriginPulls,
        );
        let items = page.pullRequests.map((pull) => Json.toChangeRequest(pull, input.repository));
        if (input.filters?.draft === "only") items = items.filter((item) => item.isDraft);
        if (input.filters?.draft === "hide") items = items.filter((item) => !item.isDraft);
        return {
          items,
          truncated: Boolean(page.nextPageToken),
          continues: Boolean(page.nextPageToken),
          ...(page.nextPageToken ? { resumeAfter: page.nextPageToken } : {}),
        };
      },
    ),

    getChangeRequestPreview: Effect.fn("OriginPullRequestProvider.getChangeRequestPreview")(
      function* (input) {
        yield* requireNative("getChangeRequestPreview", input.repository);
        const pull = yield* readPull("getChangeRequestPreview", input);
        return {
          number: pull.number,
          title: pull.title,
          url: Json.changeRequestUrl(input.repository, pull.number, pull.webUrl),
          author: Json.toActor(pull.author),
          state: Json.pullState(pull),
          isDraft: pull.draft,
          createdAt: pull.createdAt,
        };
      },
    ),

    getChangeRequest: Effect.fn("OriginPullRequestProvider.getChangeRequest")(function* (input) {
      yield* requireNative("getChangeRequest", input.repository);
      const pull = yield* readPull("getChangeRequest", input);
      const mergeability = yield* read(
        "getChangeRequest",
        { path: `/repos/${input.repository}/pulls/${input.number}/mergeability` },
        Json.OriginMergeability,
      ).pipe(Effect.orElseSucceed(() => ({ verdict: undefined, blockers: undefined })));
      const requested = yield* read(
        "getChangeRequest",
        { path: `/repos/${input.repository}/pulls/${input.number}/requested_reviewers` },
        Json.OriginRequestedReviewers,
      ).pipe(Effect.orElseSucceed(() => ({ reviewers: [], users: [] })));
      const permission = yield* read(
        "getChangeRequest",
        {
          path: `/repos/${input.repository}/collaborators/${
            pull.author?.user?.id ?? "user_self"
          }/permission`,
        },
        Json.OriginPermission,
      ).pipe(Effect.orElseSucceed(() => ({ permission: "write" as const })));
      const repo = yield* read(
        "getChangeRequest",
        { path: `/repos/${input.repository}` },
        Json.OriginRepo,
      );
      const reviewers = (requested.reviewers ?? [])
        .map((entry) =>
          Json.toActor(
            entry.user
              ? { user: entry.user }
              : entry.serviceAccount
                ? { serviceAccount: entry.serviceAccount }
                : undefined,
          ),
        )
        .filter((actor): actor is NonNullable<typeof actor> => actor !== null);
      const base = Json.toChangeRequest(pull, input.repository);
      return {
        ...base,
        headSha: pull.head.sha,
        reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
        mergeability: Json.mergeabilityOf(mergeability),
        additions: pull.additions ?? 0,
        deletions: pull.deletions ?? 0,
        changedFiles: pull.changedFiles ?? 0,
        body: pull.body ?? "",
        mergedAt: pull.merged ? (pull.mergedAt ?? null) : null,
        closedAt: Json.pullState(pull) === "closed" ? (pull.closedAt ?? null) : null,
        reviewers,
        checks: [],
        mergeCapabilities: {
          merge: repo.allowMergeCommit !== false,
          squash: repo.allowSquashMerge !== false,
          rebase: false,
        },
        viewerPermissions: Json.toViewerPermissions({
          pull,
          canWrite: permission.permission === "write" || permission.permission === "admin",
        }),
      };
    }),

    getChangeRequestStack: Effect.fn("OriginPullRequestProvider.getChangeRequestStack")(
      function* (input) {
        yield* requireNative("getChangeRequestStack", input.repository);
        const pull = yield* readPull("getChangeRequestStack", input);
        if (!pull.stack) return null;
        const page = yield* read(
          "getChangeRequestStack",
          {
            path: `/repos/${input.repository}/pulls?${new URLSearchParams({
              stackId: pull.stack.id,
              state: "all",
              pageSize: "100",
            })}`,
          },
          Json.OriginPulls,
        );
        return Json.toStack(pull, page.pullRequests, input.repository);
      },
    ),

    getChangeRequestActivity: Effect.fn("OriginPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        yield* requireNative("getChangeRequestActivity", input.repository);
        const pull = yield* readPull("getChangeRequestActivity", input);
        const base = `/repos/${input.repository}/pulls/${input.number}`;
        const [comments, reviews, commits] = yield* Effect.all(
          [
            readPages("getChangeRequestActivity", `${base}/comments?pageSize=100`, (raw) =>
              decodeComments(raw).pipe(
                Effect.mapError((cause) =>
                  failure(
                    "getChangeRequestActivity",
                    "Origin returned unreadable comments.",
                    cause,
                  ),
                ),
                Effect.map((page) => ({
                  items: page.comments,
                  next: page.nextPageToken || null,
                })),
              ),
            ).pipe(Effect.map((items) => ({ comments: items, nextPageToken: undefined }))),
            readPages("getChangeRequestActivity", `${base}/reviews?pageSize=100`, (raw) =>
              decodeReviews(raw).pipe(
                Effect.mapError((cause) =>
                  failure("getChangeRequestActivity", "Origin returned unreadable reviews.", cause),
                ),
                Effect.map((page) => ({
                  items: page.reviews,
                  next: page.nextPageToken || null,
                })),
              ),
            ).pipe(Effect.map((items) => ({ reviews: items, nextPageToken: undefined }))),
            readPages("getChangeRequestActivity", `${base}/commits?pageSize=100`, (raw) =>
              decodeCommits(raw).pipe(
                Effect.mapError((cause) =>
                  failure("getChangeRequestActivity", "Origin returned unreadable commits.", cause),
                ),
                Effect.map((page) => ({
                  items: page.commits,
                  next: page.nextPageToken || null,
                })),
              ),
            ).pipe(Effect.map((items) => ({ commits: items, nextPageToken: undefined }))),
          ],
          { concurrency: 3 },
        );
        return Json.toActivity({
          comments,
          reviews,
          commits,
          headSha: pull.head.sha,
        });
      },
    ),

    getViewerPermissions: Effect.fn("OriginPullRequestProvider.getViewerPermissions")(
      function* (input) {
        const detail = yield* provider.getChangeRequest(input);
        return detail.viewerPermissions;
      },
    ),

    getDiff: Effect.fn("OriginPullRequestProvider.getDiff")(function* (input) {
      yield* requireNative("getDiff", input.repository);
      const query = new URLSearchParams({ pageSize: "100" });
      if (input.cursor) query.set("pageToken", input.cursor);
      const files = yield* read(
        "getDiff",
        { path: `/repos/${input.repository}/pulls/${input.number}/files?${query}` },
        Json.OriginFiles,
      );
      return Json.toDiff(files);
    }),

    runAction: Effect.fn("OriginPullRequestProvider.runAction")(function* (input) {
      yield* requireNative("runAction", input.repository);
      const path = `/repos/${input.repository}/pulls/${input.number}`;
      switch (input.action) {
        case "ready":
          yield* read(
            "runAction",
            { method: "PATCH", path, body: { draft: false } },
            Json.OriginPull,
          );
          return;
        case "draft":
          yield* read(
            "runAction",
            { method: "PATCH", path, body: { draft: true } },
            Json.OriginPull,
          );
          return;
        case "close":
          yield* read(
            "runAction",
            { method: "PATCH", path, body: { state: "closed" } },
            Json.OriginPull,
          );
          return;
        case "reopen":
          yield* read(
            "runAction",
            { method: "PATCH", path, body: { state: "open" } },
            Json.OriginPull,
          );
          return;
        case "merge": {
          const method = input.mergeMethod === "squash" ? "squash" : "merge";
          if (input.mergeMethod === "rebase")
            return yield* failure("runAction", "Origin does not support rebase merges.");
          yield* send("runAction", {
            method: "POST",
            path: `${path}/merge`,
            body: { mergeMethod: method },
          });
          return;
        }
        default:
          return yield* failure("runAction", `Origin does not support the ${input.action} action.`);
      }
    }),

    updateChangeRequest: Effect.fn("OriginPullRequestProvider.updateChangeRequest")(
      function* (input) {
        yield* requireNative("updateChangeRequest", input.repository);
        yield* read(
          "updateChangeRequest",
          {
            method: "PATCH",
            path: `/repos/${input.repository}/pulls/${input.number}`,
            body: {
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
            },
          },
          Json.OriginPull,
        );
      },
    ),

    comment: Effect.fn("OriginPullRequestProvider.comment")(function* (input) {
      yield* requireNative("comment", input.repository);
      yield* send("comment", {
        method: "POST",
        path: `/repos/${input.repository}/pulls/${input.number}/comments`,
        body: { body: input.body },
      });
    }),

    updateComment: Effect.fn("OriginPullRequestProvider.updateComment")(function* (input) {
      yield* requireNative("updateComment", input.repository);
      yield* send("updateComment", {
        method: "PATCH",
        path: `/repos/${input.repository}/pulls/comments/${input.commentId}`,
        body: { body: input.body },
      });
    }),

    submitReview: Effect.fn("OriginPullRequestProvider.submitReview")(function* (input) {
      yield* requireNative("submitReview", input.repository);
      yield* send("submitReview", {
        method: "POST",
        path: `/repos/${input.repository}/pulls/${input.number}/reviews`,
        body: {
          verdict: VERDICT[input.verdict],
          body: input.body,
          comments: input.comments.map((comment) => {
            const position = comment.position;
            const inline =
              position.kind === "added"
                ? { path: comment.path, side: "right" as const, startLine: position.newLine }
                : position.kind === "deleted"
                  ? { path: comment.path, side: "left" as const, startLine: position.oldLine }
                  : {
                      path: comment.path,
                      side: position.side,
                      startLine: position.side === "left" ? position.oldLine : position.newLine,
                    };
            return { body: comment.body, inline };
          }),
        },
      });
    }),

    listReviewerCandidates: Effect.fn("OriginPullRequestProvider.listReviewerCandidates")(
      function* (input) {
        yield* requireNative("listReviewerCandidates", input.repository);
        const pull = yield* readPull("listReviewerCandidates", input);
        const authorId = pull.author?.user?.id;
        const requested = yield* read(
          "listReviewerCandidates",
          { path: `/repos/${input.repository}/pulls/${input.number}/requested_reviewers` },
          Json.OriginRequestedReviewers,
        ).pipe(Effect.orElseSucceed(() => ({ reviewers: [], users: [] })));
        const requestedIds = new Set(
          (requested.reviewers ?? [])
            .map((entry) => entry.user?.id ?? entry.group?.id ?? entry.serviceAccount?.id)
            .filter((id): id is string => id !== undefined),
        );
        const grants = yield* read(
          "listReviewerCandidates",
          { path: `/repos/${input.repository}/grants?pageSize=100` },
          Json.OriginGrants,
        ).pipe(Effect.orElseSucceed(() => ({ grants: [], nextPageToken: undefined })));
        const candidates: Array<PullRequestReviewerCandidate> = [];
        for (const grant of grants.grants) {
          if (!grant.user || grant.user.id === authorId) continue;
          const actor = Json.toActor({ user: grant.user });
          if (!actor) continue;
          candidates.push({
            ...actor,
            id: grant.user.id,
            kind: "user",
            isRequested: requestedIds.has(grant.user.id),
          });
        }
        for (const entry of requested.reviewers ?? []) {
          if (entry.user && !candidates.some((candidate) => candidate.id === entry.user!.id)) {
            const actor = Json.toActor({ user: entry.user });
            if (actor && entry.user.id !== authorId)
              candidates.push({
                ...actor,
                id: entry.user.id,
                kind: "user",
                isRequested: true,
              });
          }
        }
        return { candidates, truncated: Boolean(grants.nextPageToken) };
      },
    ),

    setReviewerRequest: Effect.fn("OriginPullRequestProvider.setReviewerRequest")(
      function* (input) {
        yield* requireNative("setReviewerRequest", input.repository);
        const reviewers = input.reviewers.map((reviewer) =>
          reviewer.kind === "team" ? { group: { id: reviewer.id } } : { user: { id: reviewer.id } },
        );
        yield* send("setReviewerRequest", {
          method: input.requested ? "POST" : "DELETE",
          path: `/repos/${input.repository}/pulls/${input.number}/requested_reviewers`,
          body: { reviewers },
        });
      },
    ),

    listLabelCandidates: Effect.fn("OriginPullRequestProvider.listLabelCandidates")(
      function* (input) {
        yield* requireNative("listLabelCandidates", input.repository);
        const pull = yield* readPull("listLabelCandidates", input);
        const applied = new Set((pull.labels ?? []).map((label) => label.name.toLowerCase()));
        const labels = yield* send("listLabelCandidates", {
          path: `/repos/${input.repository}/labels?pageSize=100`,
        }).pipe(
          Effect.flatMap((raw) =>
            decodeLabels(raw).pipe(
              Effect.mapError((cause) =>
                failure("listLabelCandidates", "Origin returned unreadable labels.", cause),
              ),
            ),
          ),
          Effect.orElseSucceed(() => ({ labels: [] })),
        );
        return {
          candidates: labels.labels.map((label) => ({
            name: label.name,
            color: label.color ? `#${label.color.replace(/^#/u, "")}` : null,
            description: label.description ?? null,
            isApplied: applied.has(label.name.toLowerCase()),
          })),
          truncated: false,
        };
      },
    ),

    setLabels: Effect.fn("OriginPullRequestProvider.setLabels")(function* (input) {
      yield* requireNative("setLabels", input.repository);
      if (input.applied) {
        yield* send("setLabels", {
          method: "POST",
          path: `/repos/${input.repository}/pulls/${input.number}/labels`,
          body: { labels: input.labels },
        });
      } else {
        for (const name of input.labels) {
          yield* send("setLabels", {
            method: "DELETE",
            path: `/repos/${input.repository}/pulls/${input.number}/labels/${encodeURIComponent(name)}`,
          });
        }
      }
    }),

    replyToThread: Effect.fn("OriginPullRequestProvider.replyToThread")(function* (input) {
      yield* requireNative("replyToThread", input.repository);
      yield* send("replyToThread", {
        method: "POST",
        path: `/repos/${input.repository}/pulls/${input.number}/comments`,
        body: { body: input.body, threadId: input.threadId },
      });
    }),

    setReaction: Effect.fn("OriginPullRequestProvider.setReaction")(function* (input) {
      if (input.subjectId === undefined)
        return yield* failure(
          "setReaction",
          "Origin supports reactions on comments only, not on the pull request description.",
        );
      yield* requireNative("setReaction", input.repository);
      const emoji = Json.REACTION_EMOJI[input.content];
      if (input.reacted) {
        yield* send("setReaction", {
          method: "POST",
          path: `/repos/${input.repository}/pulls/comments/${input.subjectId}/reactions`,
          body: { emoji },
        });
      } else {
        yield* send("setReaction", {
          method: "DELETE",
          path: `/repos/${input.repository}/pulls/comments/${input.subjectId}/reactions`,
          body: { emoji },
        });
      }
    }),

    setThreadResolution: Effect.fn("OriginPullRequestProvider.setThreadResolution")(
      function* (input) {
        yield* requireNative("setThreadResolution", input.repository);
        yield* send("setThreadResolution", {
          method: "PATCH",
          path: `/repos/${input.repository}/pulls/threads/${input.threadId}`,
          body: { resolved: input.resolved },
        });
      },
    ),
  };

  return provider;
});
