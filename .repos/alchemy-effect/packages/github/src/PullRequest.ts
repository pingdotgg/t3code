import { Query } from "@distilled.cloud/core/query";
import * as GraphQL from "@distilled.cloud/github/GraphQL";
import * as Issues from "@distilled.cloud/github/issues";
import * as Pulls from "@distilled.cloud/github/pulls";
import * as Repos from "@distilled.cloud/github/repos";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { dedent } from "alchemy/Util/dedent";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { withBaseUrl, gitHubBaseUrlChanged } from "./BaseUrl.ts";
import type * as GitHub from "./Providers.ts";

export class PullRequestUnexpectedResponse extends Data.TaggedError(
  "PullRequestUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface PullRequestProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Pull request title.
   */
  title: string;

  /**
   * Pull request body (supports GitHub Markdown).
   *
   * The body is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  body?: string;

  /**
   * The name of the branch where your changes are implemented (the source).
   */
  head: string;

  /**
   * The name of the branch you want the changes pulled into (the target).
   */
  base: string;

  /**
   * State of the pull request. Use "open" to reopen a closed PR or "closed"
   * to close an open PR. Note: only the PR owner, repo owner, or user with
   * push access can close PRs.
   * @default "open"
   */
  state?: "open" | "closed";

  /**
   * Whether the pull request is a draft.
   * @default false
   */
  draft?: boolean;

  /**
   * Labels to attach to the pull request. The provided list fully replaces
   * any existing labels.
   */
  labels?: string[];

  /**
   * Assignees (user logins) to assign to the pull request. The provided list
   * fully replaces existing assignees.
   */
  assignees?: string[];

  /**
   * Reviewers (user logins) to request reviews from. The provided list fully
   * replaces existing review requests.
   */
  reviewers?: string[];

  /**
   * Team slugs (for organization repos) to request reviews from.
   */
  teamReviewers?: string[];

  /**
   * Milestone number to assign to the pull request. Use `null` to remove
   * milestone.
   */
  milestone?: number | null;

  /**
   * Whether maintainers of the base repository can modify the pull
   * request's head branch. This does not change the pull request author.
   */
  maintainerCanModify?: boolean;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface PullRequest extends Resource<
  "GitHub.PullRequest",
  PullRequestProps,
  {
    /**
     * The numeric ID of the pull request in GitHub.
     */
    prNumber: number;

    /**
     * GraphQL node ID of the pull request.
     */
    nodeId: string;

    /**
     * URL to view the pull request in a browser.
     */
    htmlUrl: string;

    /**
     * State of the pull request (open or closed).
     */
    state: "open" | "closed";

    /**
     * Whether the pull request is merged.
     */
    merged: boolean;

    /**
     * Whether the pull request is a draft.
     */
    draft: boolean;

    /**
     * ISO-8601 timestamp of when the pull request was created.
     */
    createdAt: string;

    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub pull request.
 *
 * `PullRequest` manages the lifecycle of a pull request in a repository. PRs
 * are created on the first deploy and updated in place on subsequent deploys
 * when properties change. By default, pull requests are retained on
 * destruction to preserve history — set `destroy()` to opt in to closure.
 *
 * Authentication is resolved via the GitHub `Credentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 *
 * ### Creating Pull Requests
 * **Example:** Create a Basic Pull Request
 * ```typescript
 * const pr = yield* GitHub.PullRequest("feature-pr", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Add new feature",
 *   body: "## Changes\n\nThis PR adds...",
 *   head: "feature-branch",
 *   base: "main",
 * })
 * ```
 *
 * **Example:** Draft Pull Request with Reviewers
 * ```typescript
 * const pr = yield* GitHub.PullRequest("draft-pr", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "WIP: New feature",
 *   body: "Work in progress...",
 *   head: "feature-branch",
 *   base: "main",
 *   draft: true,
 *   reviewers: ["reviewer1", "reviewer2"],
 *   teamReviewers: ["platform-team"],
 * })
 * ```
 *
 * ### Updating Pull Requests
 * Deploy with the same logical ID and different properties to update the
 * existing PR in place rather than creating a new one.
 *
 * **Example:** Update PR State
 * ```typescript
 * const pr = yield* GitHub.PullRequest("completed-pr", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Add new feature",
 *   body: "Completed and ready to merge.",
 *   head: "feature-branch",
 *   base: "main",
 *   state: "closed",
 * })
 * ```
 *
 * ### Pull Request with Labels and Milestone
 * **Example:** Organized Pull Request
 * ```typescript
 * const pr = yield* GitHub.PullRequest("release-pr", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Release v1.0",
 *   body: "Release notes...",
 *   head: "release-1.0",
 *   base: "main",
 *   labels: ["release", "v1.0"],
 *   milestone: 1,
 * })
 * ```
 *
 * ### Infrastructure Deployment PRs
 * A common pattern is creating PRs for infrastructure changes that require
 * review before merging.
 *
 * **Example:** Infrastructure Change PR
 * ```typescript
 * yield* GitHub.PullRequest("infra-update", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Update infrastructure configuration",
 *   body: Output.interpolate`
 *     ## Infrastructure Changes
 *
 *     **Database:** ${database.endpoint}
 *     **Cache:** ${cache.endpoint}
 *
 *     Requires approval before deployment.
 *   `,
 *   head: "infra-updates",
 *   base: "main",
 *   labels: ["infrastructure"],
 *   reviewers: ["infrastructure-lead"],
 * })
 * ```
 *
 * @resource
 * @product Pull Request
 */
export const PullRequest = Resource<PullRequest>("GitHub.PullRequest", {
  defaultRemovalPolicy: "retain",
});

export const PullRequestProvider = () =>
  Provider.succeed(PullRequest, {
    stables: ["prNumber", "nodeId"],

    // A PR belongs to (host, owner, repository, head, base) — changing any
    // of these replaces the resource: a fresh PR is created with the new
    // configuration, and the old one is retained by default.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.head !== olds.head ||
        news.base !== olds.base ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(
      function* ({ news, output }) {
        const scope = { owner: news.owner, repo: news.repository };
        const body = news.body === undefined ? undefined : dedent(news.body);
        const getPull = (number: number) =>
          Pulls.get({ ...scope, pull_number: number }).pipe(
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        const findOpen = () =>
          Pulls.list({
            ...scope,
            head: news.head.includes(":") ? news.head : `${news.owner}:${news.head}`,
            base: news.base,
            state: "open",
            per_page: 100,
          }).pipe(Effect.map((pulls) => pulls[0]?.number));
        let number = output?.prNumber;
        let observed = number === undefined ? undefined : yield* getPull(number);
        if (observed === undefined) {
          number = yield* findOpen();
          if (number === undefined) {
            number = yield* Pulls.create({
              ...scope,
              title: news.title,
              body,
              head: news.head,
              base: news.base,
              draft: news.draft,
              maintainer_can_modify: news.maintainerCanModify,
            }).pipe(
              Effect.map((pull) => pull.number),
              // A 422 is a create race (an open PR already joins head and base).
              Effect.catchTag("UnprocessableEntity", (error) =>
                findOpen().pipe(
                  Effect.flatMap((existing) =>
                    existing === undefined ? Effect.fail(error) : Effect.succeed(existing),
                  ),
                ),
              ),
            );
          }
          observed = yield* getPull(number);
        }
        if (observed === undefined) {
          return yield* new PullRequestUnexpectedResponse({
            message: "Pull request disappeared during reconciliation",
          });
        }
        const state = news.state ?? "open";
        const draft = news.draft ?? false;
        const draftChanged = draft !== (observed.draft ?? false);
        const syncState = draftChanged ? "open" : state;
        if (
          observed.title !== news.title ||
          (body !== undefined && (observed.body ?? "") !== body) ||
          observed.state !== syncState ||
          (news.maintainerCanModify !== undefined &&
            observed.maintainer_can_modify !== news.maintainerCanModify)
        ) {
          yield* Pulls.update({
            ...scope,
            pull_number: observed.number,
            title: news.title,
            body,
            state: syncState,
            maintainer_can_modify: news.maintainerCanModify,
          });
        }
        // GitHub only permits draft transitions while a pull request is open,
        // and only through GraphQL.
        if (draftChanged) {
          yield* (draft ? convertToDraft : markReadyForReview)(observed.node_id);
        }
        yield* syncPullRequestMeta(news, observed.number);
        if (draftChanged && state === "closed") {
          yield* Pulls.update({ ...scope, pull_number: observed.number, state: "closed" });
        }
        const final = yield* getPull(observed.number);
        if (final === undefined) {
          return yield* new PullRequestUnexpectedResponse({
            message: "Pull request disappeared after reconciliation",
          });
        }
        return attributes(final);
      },
      (effect, { news }) => effect.pipe(withBaseUrl(news.baseUrl)),
    ),

    // Enumerate every pull request across the repositories the token can see.
    list: Effect.fn(function* () {
      const repos = yield* Stream.runCollect(
        Repos.listForAuthenticatedUser.items({ per_page: 100 }),
      );
      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Stream.runCollect(
            Pulls.list.items({
              owner: repo.owner.login,
              repo: repo.name,
              state: "all",
              per_page: 100,
            }),
          ).pipe(
            Effect.map((pulls) =>
              pulls.map((pr) => ({
                prNumber: pr.number,
                nodeId: pr.node_id,
                htmlUrl: pr.html_url,
                state: pr.state as "open" | "closed",
                merged: pr.merged_at !== null,
                draft: pr.draft ?? false,
                createdAt: pr.created_at,
                updatedAt: pr.updated_at,
              })),
            ),
            Effect.catchTag(["Forbidden", "NotFound"], () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return perRepo.flat();
    }),

    delete: Effect.fn(
      function* ({ olds, output }) {
        const pull = { owner: olds.owner, repo: olds.repository, pull_number: output.prNumber };

        // GitHub preserves pull request history; destruction closes it.
        const observed = yield* Pulls.get(pull).pipe(
          Effect.catchTag("NotFound", () => Effect.undefined),
        );
        if (observed?.state === "open") {
          yield* Pulls.update({ ...pull, state: "closed" }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }
      },
      (effect, { olds }) => effect.pipe(withBaseUrl(olds.baseUrl)),
    ),
  });

const attributes = (data: Pulls.PullRequest) => ({
  prNumber: data.number,
  nodeId: data.node_id,
  htmlUrl: data.html_url,
  state: data.state as "open" | "closed",
  merged: data.merged,
  draft: data.draft ?? false,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
});

const sameNames = (left: string[], right: string[]) =>
  JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());

const convertToDraft = Query.fn(
  (pullRequestId: string) =>
    GraphQL.GitHub.convertPullRequestToDraft({ input: { pullRequestId } }).pullRequest.id,
);

const markReadyForReview = Query.fn(
  (pullRequestId: string) =>
    GraphQL.GitHub.markPullRequestReadyForReview({ input: { pullRequestId } }).pullRequest.id,
);

const syncPullRequestMeta = Effect.fn(function* (props: PullRequestProps, prNumber: number) {
  const scope = { owner: props.owner, repo: props.repository };
  const issue = { ...scope, issue_number: prNumber };
  const data = yield* Issues.get(issue);
  const labels = data.labels.map((label) =>
    typeof label === "string" ? label : (label.name ?? ""),
  );
  if (props.labels !== undefined && !sameNames(labels, props.labels)) {
    yield* Issues.setLabels({ ...issue, body: { labels: props.labels } });
  }
  const assignees = data.assignees?.map((user) => user.login) ?? [];
  if (props.assignees !== undefined && !sameNames(assignees, props.assignees)) {
    yield* Issues.update({ ...issue, assignees: props.assignees });
  }
  if (props.milestone !== undefined && (data.milestone?.number ?? null) !== props.milestone) {
    yield* Issues.update({ ...issue, milestone: props.milestone });
  }
  if (props.reviewers !== undefined || props.teamReviewers !== undefined) {
    const pull = { ...scope, pull_number: prNumber };
    const current = yield* Pulls.listRequestedReviewers(pull);
    const users = current.users.map((user) => user.login);
    const teams = current.teams.map((team) => team.slug);
    const removeUsers =
      props.reviewers === undefined ? [] : users.filter((user) => !props.reviewers!.includes(user));
    const removeTeams =
      props.teamReviewers === undefined
        ? []
        : teams.filter((team) => !props.teamReviewers!.includes(team));
    if (removeUsers.length || removeTeams.length) {
      yield* Pulls.removeRequestedReviewers({
        ...pull,
        reviewers: removeUsers,
        team_reviewers: removeTeams,
      });
    }
    const addUsers = (props.reviewers ?? []).filter((user) => !users.includes(user));
    const addTeams = (props.teamReviewers ?? []).filter((team) => !teams.includes(team));
    if (addUsers.length || addTeams.length) {
      yield* Pulls.requestReviewers({
        ...pull,
        reviewers: addUsers,
        team_reviewers: addTeams,
      });
    }
  }
});
