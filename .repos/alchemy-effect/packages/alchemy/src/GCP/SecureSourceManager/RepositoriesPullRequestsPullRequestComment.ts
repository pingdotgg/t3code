import * as ssm from "@distilled.cloud/gcp/securesourcemanager_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  catchMissing,
  collectPages,
  expandName,
  fingerprint,
  forEachRepository,
  hasOwnershipMarker,
  nameFromOperation,
  normalizeLocation,
  ownedByAlchemy,
  PAGE_SIZE,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  retryConflict,
  sameText,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type PullRequestCommentReview = {
  /**
   * Review action (`COMMENT`, `CHANGE_REQUESTED`, `APPROVED`).
   */
  actionType?: ssm.ReviewActionTypeEnum | (string & {});
  /** Optional review summary body. */
  body?: string;
};

export type PullRequestCommentCode = {
  /** Comment body. */
  body?: string;
  /** Parent code-comment name this comment replies to. */
  reply?: string;
  /** File path of the comment. */
  position?: {
    /** Path of the file. */
    path?: string;
    /** Line number (positive = new side, negative = old side). */
    line?: string;
  };
};

export type RepositoriesPullRequestsPullRequestCommentProps = {
  /**
   * Parent pull request. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}/pullRequests/{pullRequest}`
   * or the pull-request id (combined with `repository`). Immutable —
   * changing it replaces the comment.
   */
  pullRequest: string;
  /**
   * Parent repository used when `pullRequest` is a bare id.
   */
  repository?: string;
  /**
   * Region used when `pullRequest` or `repository` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Server-assigned comment id. Set after create. Immutable — changing
   * it replaces the comment.
   */
  commentId?: string;
  /**
   * General pull-request comment. Mutually exclusive with `review` and
   * `code`. Posted as given; comments have no labels, so Alchemy tracks
   * the comment by its server-assigned id.
   */
  comment?: { body: string };
  /**
   * Review summary comment. Mutually exclusive with `comment` and `code`.
   */
  review?: PullRequestCommentReview;
  /**
   * Line-level code comment. Mutually exclusive with `comment` and
   * `review`. Creating a root code comment requires
   * `BatchCreatePullRequestComments`; this resource creates a general
   * comment or a code reply.
   */
  code?: PullRequestCommentCode;
};

export type RepositoriesPullRequestsPullRequestComment = Resource<
  "GCP.SecureSourceManager.RepositoriesPullRequestsPullRequestComment",
  RepositoriesPullRequestsPullRequestCommentProps,
  {
    /** Full resource name. */
    name: string;
    /** Server-assigned comment id. */
    commentId: string;
    /** Parent pull-request resource name. */
    pullRequest: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** General comment body with ownership prefix stripped. */
    comment: { body: string } | undefined;
    /** Review summary with ownership prefix stripped from `body`. */
    review: PullRequestCommentReview | undefined;
    /** Code comment with ownership prefix stripped from `body`. */
    code:
      | {
          body: string | undefined;
          reply: string | undefined;
          resolved: boolean | undefined;
          position:
            | {
                path: string | undefined;
                line: string | undefined;
              }
            | undefined;
        }
      | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A comment on a Secure Source Manager pull request.
 *
 * Comment ids are server-assigned. Changing `commentId` or `pullRequest`
 * replaces the comment. Body updates in place. Ownership for `list` /
 * nuke is stamped into the comment body (comments have no labels field).
 * Create a general `comment`, a `review`, or a `code` reply — batch
 * review-plus-code threads use the distilled batch-create API.
 *
 * ### Creating a Pull Request Comment
 * **Example:** General comment
 * ```typescript
 * const comment =
 *   yield* GCP.SecureSourceManager.RepositoriesPullRequestsPullRequestComment(
 *     "Note",
 *     {
 *       pullRequest: pullRequest.name,
 *       comment: { body: "looks good" },
 *     },
 *   );
 * ```
 *
 * ### Updating a Pull Request Comment
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Edit the body
 * ```typescript
 * const comment =
 *   yield* GCP.SecureSourceManager.RepositoriesPullRequestsPullRequestComment(
 *     "Note",
 *     {
 *       pullRequest: pullRequest.name,
 *       comment: { body: "looks good after the rebase" },
 *     },
 *   );
 * ```
 *
 * @resource
 * @category SecureSourceManager
 */
export const RepositoriesPullRequestsPullRequestComment =
  Resource<RepositoriesPullRequestsPullRequestComment>(
    "GCP.SecureSourceManager.RepositoriesPullRequestsPullRequestComment",
  );

const resourceName = (pullRequest: string, commentId: string) =>
  `${pullRequest}/pullRequestComments/${commentId}`;

const expandPullRequest = (
  pullRequest: string,
  repository: string | undefined,
  project: string,
  location: string,
) => {
  const next = pullRequest.replace(/\/+$/, "");
  if (next.includes("/")) return next;
  const repo = expandName(repository ?? "", project, location, "repositories");
  return repo.length > 0 ? `${repo}/pullRequests/${next}` : next;
};

const ownershipBodyOf = (item: ssm.PullRequestComment) =>
  item.comment?.body ?? item.review?.body ?? item.code?.body;

const toAttrs = (
  item: ssm.PullRequestComment,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "pullRequestComments", region);
  const commentBody = parseOwnership(item.comment?.body);
  const reviewBody = parseOwnership(item.review?.body);
  const codeBody = parseOwnership(item.code?.body);
  return {
    name,
    commentId: parsed.id,
    pullRequest: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    comment:
      item.comment === undefined ? undefined : { body: commentBody.text ?? "" },
    review:
      item.review === undefined
        ? undefined
        : {
            actionType: item.review.actionType,
            body: reviewBody.text,
          },
    code:
      item.code === undefined
        ? undefined
        : {
            body: codeBody.text,
            reply: item.code.reply,
            resolved: item.code.resolved,
            position:
              item.code.position === undefined
                ? undefined
                : {
                    path: item.code.position.path,
                    line: item.code.position.line,
                  },
          },
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const encodeBodies = (
  news: RepositoriesPullRequestsPullRequestCommentProps,
): ssm.PullRequestComment => {
  if (news.review !== undefined) {
    return {
      review: {
        actionType: news.review.actionType,
        body: news.review.body,
      },
    };
  }
  if (news.code !== undefined) {
    return {
      code: {
        body: news.code.body,
        reply: news.code.reply,
        position: news.code.position,
      },
    };
  }
  return {
    comment: {
      body: news.comment?.body,
    },
  };
};

const desiredBody = (
  news: RepositoriesPullRequestsPullRequestCommentProps,
): string | undefined =>
  news.review?.body ?? news.code?.body ?? news.comment?.body;

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        ssm.getProjectsLocationsRepositoriesPullRequestsPullRequestComments({
          name,
        }),
      );

const listOnPullRequest = (pullRequest: string) =>
  collectPages(
    ssm.listProjectsLocationsRepositoriesPullRequestsPullRequestComments.pages({
      parent: pullRequest,
      pageSize: PAGE_SIZE,
    }),
    (page) => page.pullRequestComments,
  );

const listOnRepository = (repository: string) =>
  Effect.gen(function* () {
    const pullRequests = yield* collectPages(
      ssm.listProjectsLocationsRepositoriesPullRequests.pages({
        parent: repository,
        pageSize: PAGE_SIZE,
      }),
      (page) => page.pullRequests,
    );
    const pages = yield* Effect.forEach(
      pullRequests.filter((item) => (item.name ?? "").length > 0),
      (item) => listOnPullRequest(item.name!),
      { concurrency: 4 },
    );
    return pages.flat();
  });

/**
 * A comment on the pull request with this body (or one carrying a legacy
 * ownership marker for `id`). Recovers a comment whose create succeeded but
 * was never recorded.
 */
const findMatching = (
  pullRequest: string,
  id: string,
  body: string | undefined,
) =>
  Effect.gen(function* () {
    if (pullRequest.length === 0) return undefined;
    const items = yield* listOnPullRequest(pullRequest);
    for (const item of items) {
      if (yield* ownedByAlchemy(id, ownershipBodyOf(item))) return item;
      if (sameText(ownershipBodyOf(item), body)) return item;
    }
    return undefined;
  });

const listOwned = (project: string, region: string) =>
  forEachRepository(project, region, (repository) =>
    listOnRepository(repository).pipe(
      Effect.map((items) =>
        items.filter((item) => hasOwnershipMarker(ownershipBodyOf(item))),
      ),
    ),
  );

export const RepositoriesPullRequestsPullRequestCommentProvider = () =>
  Provider.succeed(RepositoriesPullRequestsPullRequestComment, {
    stables: [
      "name",
      "commentId",
      "pullRequest",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const nextKind =
        news.review !== undefined
          ? "review"
          : news.code !== undefined
            ? "code"
            : "comment";
      const previousKind =
        olds?.review !== undefined || output?.review !== undefined
          ? "review"
          : olds?.code !== undefined || output?.code !== undefined
            ? "code"
            : olds?.comment !== undefined || output?.comment !== undefined
              ? "comment"
              : nextKind;
      return replaceOnIdentity({
        previousId: olds?.commentId ?? output?.commentId,
        nextId: news.commentId ?? olds?.commentId ?? output?.commentId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        previousParent: olds?.pullRequest ?? output?.pullRequest,
        nextParent: expandPullRequest(
          news.pullRequest,
          news.repository,
          env.project,
          location,
        ),
        extra:
          previousKind !== nextKind ||
          fingerprint(news.code?.position) !==
            fingerprint(olds?.code?.position ?? output?.code?.position) ||
          !sameText(
            news.code?.reply,
            olds?.code?.reply ?? output?.code?.reply,
          ) ||
          !sameText(
            news.review?.actionType,
            olds?.review?.actionType ?? output?.review?.actionType,
          ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const pullRequest = expandPullRequest(
        olds?.pullRequest ?? output?.pullRequest ?? "",
        olds?.repository,
        env.project,
        location,
      );
      const commentId = olds?.commentId ?? output?.commentId;
      const name =
        output?.name ??
        (commentId !== undefined && pullRequest.length > 0
          ? resourceName(pullRequest, commentId)
          : "");
      let existing = yield* getByName(name);
      const recorded = existing !== undefined && output !== undefined;
      if (existing === undefined && olds !== undefined) {
        existing = yield* findMatching(pullRequest, id, desiredBody(olds));
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const { labels } = parseOwnership(ownershipBodyOf(existing));
      // A matching comment found without a recorded id could be anyone's.
      return recorded || (yield* hasAlchemyLabels(id, labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item: ssm.PullRequestComment) =>
          toAttrs(item, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const pullRequest = expandPullRequest(
        news.pullRequest,
        news.repository,
        env.project,
        location,
      );
      const encoded = encodeBodies(news);
      const name =
        output?.name ??
        (news.commentId !== undefined
          ? resourceName(pullRequest, news.commentId)
          : "");

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findMatching(pullRequest, id, desiredBody(news));
      }

      if (current === undefined) {
        const created = yield* ssm
          .createProjectsLocationsRepositoriesPullRequestsPullRequestComments({
            parent: pullRequest,
            body: encoded,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const operation = yield* waitForOperation(created);
          const createdName = nameFromOperation(operation);
          if (createdName !== undefined) {
            current = yield* waitUntilExists(
              getByName(createdName),
              createdName,
            );
          }
        }
        if (current === undefined) {
          current = yield* findMatching(pullRequest, id, desiredBody(news));
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: name || pullRequest,
        });
      }

      const currentName = current.name ?? name;
      // Raw body: also rewrites a legacy ownership marker away.
      if (!sameText(ownershipBodyOf(current), desiredBody(news))) {
        const operation =
          yield* ssm.patchProjectsLocationsRepositoriesPullRequestsPullRequestComments(
            {
              name: currentName,
              updateMask: "body",
              body: encoded,
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(getByName(currentName), currentName);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryConflict(
        ssm
          .deleteProjectsLocationsRepositoriesPullRequestsPullRequestComments({
            name: output.name,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
