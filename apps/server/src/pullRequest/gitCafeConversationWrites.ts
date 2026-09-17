import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";

import type * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import { gitCafeWriteApi } from "./gitCafeWriteApi.ts";
import { ReactionsSchema, RawPullSchema } from "./gitCafePullRequestJson.ts";

type Writes = Pick<
  PullRequestProviderApi,
  | "comment"
  | "updateChangeRequest"
  | "updateComment"
  | "replyToThread"
  | "setThreadResolution"
  | "setReaction"
  | "listReviewerCandidates"
  | "setReviewerRequest"
  | "listLabelCandidates"
  | "setLabels"
>;

const Id = TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));
const WrittenComment = Schema.Struct({ id: Id, threadId: Id, version: NonNegativeInt });
const CommentDetail = Schema.Struct({
  id: Id,
  threadId: Id,
  version: NonNegativeInt,
  resolvedAt: Schema.NullOr(Schema.String),
  capabilities: Schema.optional(
    Schema.Struct({
      edit: Schema.Boolean,
      hide: Schema.Boolean,
      unhide: Schema.Boolean,
      delete: Schema.Boolean,
      resolve: Schema.Boolean,
      unresolve: Schema.Boolean,
    }),
  ),
});
const CommentPage = Schema.Struct({
  items: Schema.Array(CommentDetail),
  nextAfter: Schema.NullOr(Id),
});
const Actor = Schema.Struct({
  id: Id,
  actor: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("local"),
      actorId: Id,
      handle: Id,
      displayName: Schema.NullOr(Schema.String),
      avatarUrl: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal("github"),
      actorId: Id,
      login: Id,
      avatarUrl: Schema.NullOr(Schema.String),
      linkedProfile: Schema.optional(Schema.Unknown),
    }),
    Schema.Struct({ kind: Schema.Literal("unavailable"), actorId: Id }),
  ]),
  handle: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
const ActorPage = Schema.Struct({
  kind: Schema.String,
  items: Schema.Array(Actor),
  nextAfter: Schema.NullOr(Id),
});
const ReviewState = Schema.Struct({
  id: Id,
  verdict: Schema.Literals(["approve", "request_changes", "comment"]),
  commitOid: Schema.String,
  dismissedAt: Schema.NullOr(Schema.String),
  stale: Schema.Boolean,
});
const ReviewerPage = Schema.Struct({
  kind: Schema.Literal("reviewers"),
  items: Schema.Array(
    Schema.Struct({
      ...Actor.fields,
      requestedByActorId: Schema.NullOr(Id),
      requestedAt: Schema.String,
      latestReview: Schema.NullOr(ReviewState),
    }),
  ),
  nextAfter: Schema.NullOr(Id),
});
const Label = Schema.Struct({
  id: Id,
  name: Schema.String,
  color: Schema.String,
  description: Schema.NullOr(Schema.String),
});
const LabelPage = Schema.Struct({ items: Schema.Array(Label), nextAfter: Schema.NullOr(Id) });
const AssignedLabelPage = Schema.Struct({
  kind: Schema.String,
  items: Schema.Array(Label),
  nextAfter: Schema.NullOr(Id),
});
const AssignmentReceipt = Schema.Struct({ version: NonNegativeInt });
const PullUpdateReceipt = Schema.Struct({ version: NonNegativeInt });
const Reaction = Schema.Struct({ id: Id });

const EMOJI = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
} as const;

export function makeGitCafeConversationWrites(cli: GitCafeCli.GitCafeCli["Service"]): Writes {
  const request = gitCafeWriteApi(cli);
  const pullPath = (number: number) => `/pulls/${number}`;
  const id = (value: string) => encodeURIComponent(value);
  const inputId = (operation: string, value: string) =>
    Schema.decodeEffect(Id)(value).pipe(
      Effect.map(id),
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: "gitcafe",
            operation,
            reason: "failed",
            detail: "Invalid GitCafe resource ID.",
            cause,
          }),
      ),
    );
  const query = (after: string | null) =>
    `?limit=100${after === null ? "" : `&after=${id(after)}`}`;
  const pages = <A>(
    input: ProviderRepositoryRef & { readonly number: number },
    path: string,
    schema: Schema.Schema<{
      readonly items: ReadonlyArray<A>;
      readonly nextAfter: string | null;
    }> & { readonly DecodingServices: never },
    operation: string,
  ) =>
    Effect.gen(function* () {
      const items: A[] = [];
      const cursors = new Set<string>();
      let after: string | null = null;
      do {
        const page: { readonly items: ReadonlyArray<A>; readonly nextAfter: string | null } =
          yield* request(input, `${path}${query(after)}`, schema, { operation });
        items.push(...page.items);
        if (page.nextAfter !== null && (page.nextAfter === after || cursors.has(page.nextAfter))) {
          return yield* new PullRequestProviderError({
            provider: "gitcafe",
            operation,
            reason: "failed",
            detail: "GitCafe returned an incomplete pagination traversal.",
          });
        }
        if (after !== null) cursors.add(after);
        after = page.nextAfter;
      } while (after !== null);
      return items;
    });
  const pull = (input: ProviderRepositoryRef & { readonly number: number }, operation: string) =>
    request(input, pullPath(input.number), RawPullSchema, { operation });
  const comments = (
    input: ProviderRepositoryRef & { readonly number: number },
    operation: string,
  ) => pages(input, `${pullPath(input.number)}/comments/`, CommentPage, operation);

  return {
    comment: (input) =>
      request(input, `${pullPath(input.number)}/comments/`, WrittenComment, {
        operation: "comment",
        method: "POST",
        body: { body: input.body },
      }).pipe(Effect.asVoid),
    replyToThread: (input) =>
      Effect.gen(function* () {
        const threadId = yield* inputId("replyToThread", input.threadId);
        yield* request(
          input,
          `${pullPath(input.number)}/comments/${threadId}/replies`,
          WrittenComment,
          { operation: "replyToThread", method: "POST", body: { body: input.body } },
        );
      }),
    updateChangeRequest: (input) =>
      Effect.gen(function* () {
        const current = yield* pull(input, "updateChangeRequest");
        yield* request(input, pullPath(input.number), PullUpdateReceipt, {
          operation: "updateChangeRequest",
          method: "PATCH",
          body: {
            expectedVersion: current.version,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { description: input.body }),
          },
        });
      }),
    updateComment: (input) =>
      Effect.gen(function* () {
        const commentId = yield* inputId("updateComment", input.commentId);
        const path = `${pullPath(input.number)}/comments/${commentId}`;
        const detail = yield* request(input, `${path}/detail`, CommentDetail, {
          operation: "updateComment",
        });
        yield* request(input, path, WrittenComment, {
          operation: "updateComment",
          method: "PATCH",
          body: { body: input.body, expectedVersion: detail.version },
        });
      }),
    setThreadResolution: (input) =>
      Effect.gen(function* () {
        const root = (yield* comments(input, "setThreadResolution")).find(
          (comment) => comment.id === input.threadId && comment.threadId === input.threadId,
        );
        if (root === undefined)
          return yield* new PullRequestProviderError({
            provider: "gitcafe",
            operation: "setThreadResolution",
            reason: "failed",
            detail: "GitCafe did not return the thread root.",
          });
        const action = input.resolved ? "resolve" : "unresolve";
        const already = input.resolved ? root.resolvedAt !== null : root.resolvedAt === null;
        if (already) return;
        if (root.capabilities?.[action] !== true)
          return yield* new PullRequestProviderError({
            provider: "gitcafe",
            operation: "setThreadResolution",
            reason: "failed",
            detail: `GitCafe does not allow this thread to be ${input.resolved ? "resolved" : "unresolved"}.`,
          });
        if (!already)
          yield* request(
            input,
            `${pullPath(input.number)}/comments/${id(root.id)}/${action}`,
            WrittenComment,
            {
              operation: "setThreadResolution",
              method: "POST",
              body: { expectedVersion: root.version },
            },
          );
      }),
    listReviewerCandidates: (input) =>
      Effect.gen(function* () {
        const [current, candidates, pr] = yield* Effect.all([
          pages(
            input,
            `${pullPath(input.number)}/reviewers`,
            ReviewerPage,
            "listReviewerCandidates",
          ),
          pages(
            input,
            `${pullPath(input.number)}/assignee-candidates`,
            ActorPage,
            "listReviewerCandidates",
          ),
          pull(input, "listReviewerCandidates"),
        ]);
        const requested = new Set(current.map((entry) => entry.id));
        return {
          candidates: candidates.flatMap((entry) =>
            entry.actor.kind === "unavailable" || entry.actor.actorId === pr.author.actorId
              ? []
              : [
                  {
                    id: entry.id,
                    kind: "user" as const,
                    login:
                      entry.handle ??
                      (entry.actor.kind === "local" ? entry.actor.handle : entry.actor.login),
                    name: entry.displayName,
                    avatarUrl: entry.avatarUrl,
                    isRequested: requested.has(entry.id),
                  },
                ],
          ),
          truncated: false,
        };
      }),
    setReviewerRequest: (input) =>
      Effect.gen(function* () {
        if (input.reviewers.some((reviewer) => reviewer.kind !== "user"))
          return yield* new PullRequestProviderError({
            provider: "gitcafe",
            operation: "setReviewerRequest",
            reason: "failed",
            detail: "GitCafe only supports user reviewers.",
          });
        const pr = yield* pull(input, "setReviewerRequest");
        const current = yield* pages(
          input,
          `${pullPath(input.number)}/reviewers`,
          ReviewerPage,
          "setReviewerRequest",
        );
        const ids = new Set(current.map((entry) => entry.id));
        for (const reviewer of input.reviewers)
          input.requested ? ids.add(reviewer.id) : ids.delete(reviewer.id);
        if (ids.size > 20)
          return yield* new PullRequestProviderError({
            provider: "gitcafe",
            operation: "setReviewerRequest",
            reason: "failed",
            detail: "GitCafe allows at most 20 reviewers.",
          });
        yield* request(input, `${pullPath(input.number)}/reviewers`, AssignmentReceipt, {
          operation: "setReviewerRequest",
          method: "PUT",
          body: { expectedVersion: pr.version, actorIds: [...ids] },
        });
      }),
    listLabelCandidates: (input) =>
      Effect.gen(function* () {
        const [all, applied] = yield* Effect.all([
          pages(input, "/labels", LabelPage, "listLabelCandidates"),
          pages(
            input,
            `${pullPath(input.number)}/labels`,
            AssignedLabelPage,
            "listLabelCandidates",
          ),
        ]);
        const names = new Set(applied.map((label) => label.name));
        return {
          candidates: all.map((label) => ({
            name: label.name,
            color: label.color,
            description: label.description,
            isApplied: names.has(label.name),
          })),
          truncated: false,
        };
      }),
    setLabels: (input) =>
      Effect.gen(function* () {
        const pr = yield* pull(input, "setLabels");
        const [catalog, current] = yield* Effect.all([
          pages(input, "/labels", LabelPage, "setLabels"),
          pages(input, `${pullPath(input.number)}/labels`, AssignedLabelPage, "setLabels"),
        ]);
        const byName = new Map(catalog.map((label) => [label.name, label.id]));
        const ids = new Set(current.map((label) => label.id));
        for (const name of input.labels) {
          const labelId = byName.get(name);
          if (labelId === undefined)
            return yield* new PullRequestProviderError({
              provider: "gitcafe",
              operation: "setLabels",
              reason: "failed",
              detail: `GitCafe label “${name}” no longer exists.`,
            });
          input.applied ? ids.add(labelId) : ids.delete(labelId);
        }
        if (ids.size > 100)
          return yield* new PullRequestProviderError({
            provider: "gitcafe",
            operation: "setLabels",
            reason: "failed",
            detail: "GitCafe allows at most 100 labels.",
          });
        yield* request(input, `${pullPath(input.number)}/labels`, AssignmentReceipt, {
          operation: "setLabels",
          method: "PUT",
          body: { expectedVersion: pr.version, labelIds: [...ids] },
        });
      }),
    setReaction: (input) =>
      Effect.gen(function* () {
        const pr = yield* pull(input, "setReaction");
        const path = `${pullPath(input.number)}/reactions/`;
        const reactions = yield* request(input, path, ReactionsSchema, {
          operation: "setReaction",
        });
        const emoji = EMOJI[input.content];
        const subject =
          input.subjectId === undefined
            ? { kind: "pull_request" as const, id: pr.id }
            : { kind: "pull_request_comment" as const, id: input.subjectId };
        const match = reactions.items.find(
          (item) =>
            item.subject.kind === subject.kind &&
            item.subject.id === subject.id &&
            item.emoji.kind === "unicode" &&
            item.emoji.value.replaceAll("\uFE0F", "") === emoji.replaceAll("\uFE0F", ""),
        );
        if (
          input.reacted ===
          (match?.viewerReactionId !== null && match?.viewerReactionId !== undefined)
        )
          return;
        if (input.reacted) {
          yield* request(input, path, Reaction, {
            operation: "setReaction",
            method: "POST",
            body: { subject, emoji: { kind: "unicode", value: emoji } },
          });
          return;
        }
        const reactionId = match?.viewerReactionId;
        if (reactionId === null || reactionId === undefined) return;
        yield* cli
          .api({
            cwd: input.cwd,
            host: input.host,
            endpoint: `/repos/${input.repository.split("/").map(id).join("/")}${path}${id(reactionId)}`,
            method: "DELETE",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PullRequestProviderError({
                  provider: "gitcafe",
                  operation: "setReaction",
                  reason:
                    cause.code === "CLI_UNAVAILABLE"
                      ? "missing-tool"
                      : cause.status === 401 || cause.code === "AUTHENTICATION_REQUIRED"
                        ? "unauthenticated"
                        : cause.status === 429 || cause.code === "RATE_LIMITED"
                          ? "rate-limited"
                          : "failed",
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
      }),
  };
}
