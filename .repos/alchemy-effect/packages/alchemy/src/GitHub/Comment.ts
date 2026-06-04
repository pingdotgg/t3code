import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { dedent } from "../Util/dedent.ts";
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
   * GitHub API token. If not provided, falls back to
   * `GITHUB_ACCESS_TOKEN` or `GITHUB_TOKEN` environment variables.
   */
  token?: string;
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
 *
 * @section Creating Comments
 * @example Comment on an Issue
 * ```typescript
 * const comment = yield* GitHub.Comment("issue-comment", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   issueNumber: 123,
 *   body: "This is a comment created by Alchemy!",
 * });
 * ```
 *
 * @example Comment on a Pull Request
 * ```typescript
 * const prComment = yield* GitHub.Comment("pr-comment", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   issueNumber: 456,
 *   body: "## Deployment Status\n\nSuccessfully deployed to staging!",
 * });
 * ```
 *
 * @section Updating Comments
 * Deploy with the same logical ID and a different `body` to update the
 * existing comment in place rather than creating a new one.
 *
 * @example Update Comment Content
 * ```typescript
 * const comment = yield* GitHub.Comment("status-comment", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   issueNumber: 789,
 *   body: "Deployment completed successfully!",
 * });
 * ```
 *
 * @section Deleting Comments
 * @example Allow Comment Deletion
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
 * @section CI Preview Comments
 * A common pattern is posting a preview-deployment URL on every pull request.
 * The comment auto-updates on each push because the logical ID stays the same.
 *
 * @example PR Preview Comment
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
 */
export const Comment = Resource<Comment>("GitHub.Comment");

function resolveToken(props: CommentProps): string | undefined {
  return (
    props.token ?? process.env.GITHUB_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN
  );
}

function createClient(props: CommentProps): Octokit {
  return new Octokit({ auth: resolveToken(props) });
}

export const CommentProvider = () =>
  Provider.succeed(Comment, {
    stables: ["commentId"],

    reconcile: Effect.fn(function* ({ news, output }) {
      const octokit = createClient(news);
      const body = dedent(news.body);

      // Observe — GitHub assigns `comment_id` server-side. Probe for live
      // state via the cached id; a 404 (deleted out-of-band, or never
      // created) collapses to "no observed comment" so we converge by
      // posting a fresh one.
      const observedId = output?.commentId
        ? yield* Effect.tryPromise({
            try: async () => {
              try {
                const { data } = await octokit.rest.issues.getComment({
                  owner: news.owner,
                  repo: news.repository,
                  comment_id: output.commentId,
                });
                return data.id;
              } catch (error: any) {
                if (error.status === 404) return undefined;
                throw error;
              }
            },
            catch: (e) => e as Error,
          })
        : undefined;

      // Ensure — when no live comment exists, POST creates one.
      if (observedId === undefined) {
        const { data } = yield* Effect.tryPromise(() =>
          octokit.rest.issues.createComment({
            owner: news.owner,
            repo: news.repository,
            issue_number: news.issueNumber,
            body,
          }),
        );
        return {
          commentId: data.id,
          htmlUrl: data.html_url,
          updatedAt: data.updated_at,
        };
      }

      // Sync — PATCH the existing comment with the desired body. GitHub's
      // updateComment is idempotent for identical bodies (returns same
      // updatedAt), so we always issue the call rather than diffing.
      const { data } = yield* Effect.tryPromise(() =>
        octokit.rest.issues.updateComment({
          owner: news.owner,
          repo: news.repository,
          comment_id: observedId,
          body,
        }),
      );
      return {
        commentId: data.id,
        htmlUrl: data.html_url,
        updatedAt: data.updated_at,
      };
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if (!olds.allowDelete) {
        return;
      }

      const octokit = createClient(olds);

      yield* Effect.tryPromise(async () => {
        try {
          await octokit.rest.issues.deleteComment({
            owner: olds.owner,
            repo: olds.repository,
            comment_id: output.commentId,
          });
        } catch (error: any) {
          if (error.status !== 404) {
            throw error;
          }
        }
      });
    }),
  });
