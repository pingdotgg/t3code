import * as Issues from "@distilled.cloud/github/issues";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { dedent } from "alchemy/Util/dedent";
import * as Effect from "effect/Effect";
import { gitHubBaseUrlChanged, withBaseUrl } from "./BaseUrl.ts";
import * as GitHub from "./Providers.ts";

export interface CommentProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Issue or Pull Request number to comment on.
   */
  issueNumber: number;

  /**
   * Comment body (supports GitHub Markdown).
   *
   * The body is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  body: string;

  /**
   * Whether to allow deletion of the comment when the resource is destroyed.
   * By default, comments are never deleted to preserve discussion history.
   * @default false
   */
  allowDelete?: boolean;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Comment extends Resource<
  "GitHub.Comment",
  CommentProps,
  {
    /**
     * The numeric ID of the comment in GitHub.
     */
    commentId: number;

    /**
     * URL to view the comment in a browser.
     */
    htmlUrl: string;

    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub issue or pull request comment.
 *
 * `Comment` manages the lifecycle of a single comment on an issue or pull
 * request. Comments are created on the first deploy and updated in place on
 * subsequent deploys when the `body` changes. By default, comments are never
 * deleted to preserve discussion history — set `allowDelete: true` to opt in.
 *
 * Authentication is resolved in order: explicit `token` prop,
 * `GITHUB_ACCESS_TOKEN` env var, `GITHUB_TOKEN` env var. The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 * ### Creating Comments
 * **Example:** Comment on an Issue
 * ```typescript
 * const comment = yield* GitHub.Comment("issue-comment", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   issueNumber: 123,
 *   body: "This is a comment created by Alchemy!",
 * });
 * ```
 *
 * **Example:** Comment on a Pull Request
 * ```typescript
 * const prComment = yield* GitHub.Comment("pr-comment", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   issueNumber: 456,
 *   body: "## Deployment Status\n\nSuccessfully deployed to staging!",
 * });
 * ```
 *
 * ### Updating Comments
 * Deploy with the same logical ID and a different `body` to update the
 * existing comment in place rather than creating a new one.
 *
 * **Example:** Update Comment Content
 * ```typescript
 * const comment = yield* GitHub.Comment("status-comment", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   issueNumber: 789,
 *   body: "Deployment completed successfully!",
 * });
 * ```
 *
 * ### Deleting Comments
 * **Example:** Allow Comment Deletion
 * ```typescript
 * const comment = yield* GitHub.Comment("temp-comment", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   issueNumber: 123,
 *   body: "This comment can be deleted",
 *   allowDelete: true,
 * });
 * ```
 *
 * ### CI Preview Comments
 * A common pattern is posting a preview-deployment URL on every pull request.
 * The comment auto-updates on each push because the logical ID stays the same.
 *
 * **Example:** PR Preview Comment
 * ```typescript
 * if (process.env.PULL_REQUEST) {
 *   yield* GitHub.Comment("preview-comment", {
 *     owner: "my-org",
 *     repository: "my-repo",
 *     issueNumber: Number(process.env.PULL_REQUEST),
 *     body: Output.interpolate`
 *       ## Preview Deployed
 *
 *       **URL:** ${website.url}
 *     `,
 *   });
 * }
 * ```
 *
 * @resource
 * @product Issue
 */
export const Comment = Resource<Comment>("GitHub.Comment");

export const CommentProvider = () =>
  Provider.succeed(Comment, {
    stables: ["commentId"],
    // Non-listable: a Comment is identified entirely by its parent
    // {owner, repository, issueNumber} plus the server-assigned commentId.
    // GitHub only exposes comment enumeration *within* a specific issue or PR
    // (`issues.listComments`); there is no account- or repo-wide API to
    // enumerate every comment without first knowing the issue/PR. With no
    // ambient scope to enumerate from, this collapses to the empty list.
    list: () => Effect.succeed([]),

    // A comment belongs to (host, owner, repository, issueNumber) — its
    // server-assigned id is meaningless anywhere else, so moving it replaces
    // the resource: a fresh comment is posted on the new issue, and the old
    // one is deleted only when `allowDelete` is set (the provider's `delete`
    // no-ops otherwise, preserving discussion history — the default).
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.issueNumber !== olds.issueNumber ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(
      function* ({ news, output }) {
        const body = dedent(news.body);
        const scope = { owner: news.owner, repo: news.repository };

        // Observe — GitHub assigns `comment_id` server-side. Probe for live
        // state via the cached id; a 404 (deleted out-of-band, or never
        // created) collapses to "no observed comment" so we converge by
        // posting a fresh one.
        const observed = output?.commentId
          ? yield* Issues.getComment({ ...scope, comment_id: output.commentId }).pipe(
              Effect.catchTag("NotFound", () => Effect.undefined),
            )
          : undefined;

        // Ensure — when no live comment exists, POST creates one. Sync — PATCH
        // the existing comment with the desired body. GitHub's updateComment is
        // idempotent for identical bodies (returns same updatedAt), so we
        // always issue the call rather than diffing.
        const data =
          observed === undefined
            ? yield* Issues.createComment({ ...scope, issue_number: news.issueNumber, body })
            : yield* Issues.updateComment({ ...scope, comment_id: observed.id, body });
        return {
          commentId: data.id,
          htmlUrl: data.html_url,
          updatedAt: data.updated_at,
        };
      },
      (effect, { news }) => effect.pipe(withBaseUrl(news.baseUrl)),
    ),

    delete: Effect.fn(
      function* ({ olds, output }) {
        if (!olds.allowDelete) {
          return;
        }
        yield* Issues.deleteComment({
          owner: olds.owner,
          repo: olds.repository,
          comment_id: output.commentId,
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      },
      (effect, { olds }) => effect.pipe(withBaseUrl(olds.baseUrl)),
    ),
  });
