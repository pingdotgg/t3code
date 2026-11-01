import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { dedent } from "../Util/dedent.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface IssueProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Issue title.
   */
  title: string;

  /**
   * Issue body (supports GitHub Markdown).
   *
   * The body is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  body?: string;

  /**
   * State of the issue. Use "open" to reopen a closed issue or "closed" to
   * close an open issue.
   * @default "open"
   */
  state?: "open" | "closed";

  /**
   * Labels to attach to the issue. The provided list fully replaces any
   * existing labels.
   */
  labels?: string[];

  /**
   * Assignees (user logins) to assign to the issue. The provided list fully
   * replaces existing assignees.
   */
  assignees?: string[];

  /**
   * Milestone number to assign to the issue. Use `null` to remove milestone.
   */
  milestone?: number | null;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Issue extends Resource<
  "GitHub.Issue",
  IssueProps,
  {
    /**
     * The numeric ID of the issue in GitHub.
     */
    issueNumber: number;

    /**
     * GraphQL node ID of the issue.
     */
    nodeId: string;

    /**
     * URL to view the issue in a browser.
     */
    htmlUrl: string;

    /**
     * State of the issue (open or closed).
     */
    state: "open" | "closed";

    /**
     * ISO-8601 timestamp of when the issue was created.
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
 * A GitHub repository issue.
 *
 * `Issue` manages the lifecycle of a single issue in a repository. Issues are
 * created on the first deploy and updated in place on subsequent deploys when
 * properties change. By default, issues are retained on destruction to preserve
 * discussion history. Pipe the resource through `destroy()` to close the issue
 * on destruction instead; its discussion remains on GitHub.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 *
 * ### Creating Issues
 * **Example:** Create a Basic Issue
 * ```typescript
 * const issue = yield* GitHub.Issue("bug-report", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Bug: Application crashes on startup",
 *   body: "## Description\n\nThe application crashes when...",
 * })
 * ```
 *
 * **Example:** Issue with Labels and Assignees
 * ```typescript
 * const issue = yield* GitHub.Issue("feature-request", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Feature: Add dark mode",
 *   body: "Users have requested...",
 *   labels: ["enhancement", "ui"],
 *   assignees: ["developer1"],
 * })
 * ```
 *
 * ### Updating Issues
 * Deploy with the same logical ID and different properties to update the
 * existing issue in place rather than creating a new one.
 *
 * **Example:** Update Issue State
 * ```typescript
 * const issue = yield* GitHub.Issue("resolved-bug", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Bug: Application crashes on startup",
 *   body: "This has been resolved.",
 *   state: "closed",
 * })
 * ```
 *
 * ### Issue with Milestone
 * **Example:** Assign to Milestone
 * ```typescript
 * const issue = yield* GitHub.Issue("v1-task", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Implement authentication",
 *   milestone: 1,
 * })
 * ```
 *
 * ### Tracking Infrastructure Changes
 * A common pattern is creating issues to track infrastructure changes or
 * deployment status.
 *
 * **Example:** Infrastructure Status Issue
 * ```typescript
 * yield* GitHub.Issue("infra-status", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Infrastructure Status",
 *   body: Output.interpolate`
 *     ## Current Status
 *
 *     **Database:** ${database.endpoint}
 *     **Cache:** ${cache.endpoint}
 *   `,
 *   labels: ["infrastructure"],
 * })
 * ```
 *
 * @resource
 * @product Issue
 */
export const Issue = Resource<Issue>("GitHub.Issue", {
  defaultRemovalPolicy: "retain",
});

export const IssueProvider = () =>
  Provider.succeed(Issue, {
    stables: ["issueNumber", "nodeId"],

    // An issue belongs to (host, owner, repository) — its server-assigned
    // number is meaningless elsewhere, so moving it replaces the resource:
    // a fresh issue is created on the new repository, and the old one is
    // retained by default (matching the resource's `retain` removal policy).
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const octokit = yield* octokitFor(news.baseUrl);
      const body = news.body ? dedent(news.body) : "";
      const state = news.state ?? "open";
      const labels = news.labels ?? [];
      const assignees = news.assignees ?? [];
      const milestone = news.milestone ?? null;

      let data =
        output?.issueNumber !== undefined
          ? yield* Effect.tryPromise({
              try: () =>
                octokit.rest.issues.get({
                  owner: news.owner,
                  repo: news.repository,
                  issue_number: output.issueNumber,
                }),
              catch: (error) => error as Error & { status?: number },
            }).pipe(
              Effect.map((response) => response.data),
              Effect.catchIf(
                (error) => error.status === 404,
                () => Effect.succeed(undefined),
              ),
            )
          : undefined;

      if (data === undefined) {
        const created = yield* Effect.tryPromise(() =>
          octokit.rest.issues.create({
            owner: news.owner,
            repo: news.repository,
            title: news.title,
            body,
            labels,
            assignees,
            milestone: milestone ?? undefined,
          }),
        );
        data = created.data;
      }

      const sameNames = (observed: string[], desired: string[]) =>
        JSON.stringify(observed.map((name) => name.toLowerCase()).sort()) ===
        JSON.stringify(desired.map((name) => name.toLowerCase()).sort());

      // Creation always opens an issue; sync also applies the desired initial state.
      if (
        data.title !== news.title ||
        (data.body ?? "") !== body ||
        data.state !== state ||
        !sameNames(
          data.labels.map((label) =>
            typeof label === "string" ? label : (label.name ?? ""),
          ),
          labels,
        ) ||
        !sameNames(
          (data.assignees ?? []).map((assignee) => assignee.login),
          assignees,
        ) ||
        (data.milestone?.number ?? null) !== milestone
      ) {
        const issueNumber = data.number;
        const updated = yield* Effect.tryPromise(() =>
          octokit.rest.issues.update({
            owner: news.owner,
            repo: news.repository,
            issue_number: issueNumber,
            title: news.title,
            body,
            state,
            labels,
            assignees,
            milestone,
          }),
        );
        data = updated.data;
      }
      return {
        issueNumber: data.number,
        nodeId: data.node_id,
        htmlUrl: data.html_url,
        state: data.state as "open" | "closed",
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    }),

    // Enumerate every issue across the repositories the token can see.
    list: Effect.fn(function* () {
      const octokit = yield* Octokit;

      const repos = yield* Effect.tryPromise({
        try: () =>
          octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
            per_page: 100,
          }),
        catch: (e) => e as Error,
      });

      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Effect.tryPromise({
            try: async () => {
              try {
                const issues = await octokit.paginate(
                  octokit.rest.issues.listForRepo,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    state: "all",
                    per_page: 100,
                  },
                );
                // Filter out pull requests (they appear in issues API)
                return issues
                  .filter((issue) => !issue.pull_request)
                  .map((issue) => ({
                    issueNumber: issue.number,
                    nodeId: issue.node_id,
                    htmlUrl: issue.html_url,
                    state: issue.state as "open" | "closed",
                    createdAt: issue.created_at,
                    updatedAt: issue.updated_at,
                  }));
              } catch (error: any) {
                if (error.status === 403 || error.status === 404) {
                  return [];
                }
                throw error;
              }
            },
            catch: (e) => e as Error,
          }),
        { concurrency: 10 },
      );

      return perRepo.flat();
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);

      // Opted-in destruction closes the issue without deleting its discussion.
      if (output?.issueNumber !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            octokit.rest.issues.update({
              owner: olds.owner,
              repo: olds.repository,
              issue_number: output.issueNumber,
              state: "closed",
            }),
          catch: (error) => error as Error & { status?: number },
        }).pipe(
          Effect.catchIf(
            (error) => error.status === 404,
            () => Effect.void,
          ),
        );
      }
    }),
  });
