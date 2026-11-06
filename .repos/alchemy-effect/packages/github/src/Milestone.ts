import * as Issues from "@distilled.cloud/github/issues";
import * as Repos from "@distilled.cloud/github/repos";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { withBaseUrl, gitHubBaseUrlChanged } from "./BaseUrl.ts";
import type * as GitHub from "./Providers.ts";

export interface MilestoneProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Milestone title. The title is the milestone's identity — changing it
   * replaces the milestone.
   */
  title: string;

  /**
   * Milestone state.
   * @default "open"
   */
  state?: "open" | "closed";

  /**
   * Description of the milestone.
   */
  description?: string;

  /**
   * Due date for the milestone (ISO-8601 format: `YYYY-MM-DD` or full
   * `YYYY-MM-DDTHH:MM:SSZ`).
   */
  dueOn?: string;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Milestone extends Resource<
  "GitHub.Milestone",
  MilestoneProps,
  {
    /**
     * The numeric milestone number.
     */
    milestoneNumber: number;

    /**
     * GraphQL node ID of the milestone.
     */
    nodeId: string;

    /**
     * The milestone title.
     */
    title: string;

    /**
     * Current state of the milestone.
     */
    state: "open" | "closed";

    /**
     * Milestone description.
     */
    description: string | null;

    /**
     * Due date for the milestone (ISO-8601 format).
     */
    dueOn: string | null;

    /**
     * URL to view the milestone in a browser.
     */
    htmlUrl: string;

    /**
     * ISO-8601 timestamp of when the milestone was created.
     */
    createdAt: string;

    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;

    /**
     * ISO-8601 timestamp when the milestone was closed.
     */
    closedAt: string | null;

    /**
     * Number of open issues in this milestone.
     */
    openIssues: number;

    /**
     * Number of closed issues in this milestone.
     */
    closedIssues: number;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub milestone.
 *
 * `Milestone` manages repository milestones for tracking issues and pull
 * requests. Milestones are created on first deploy and updated in place on
 * subsequent deploys when properties change.
 *
 * Authentication is resolved via the GitHub `Credentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 * ### Creating Milestones
 * **Example:** Basic Milestone
 * ```typescript
 * const v1 = yield* GitHub.Milestone("v1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "v1.0.0",
 *   description: "First stable release",
 * });
 * ```
 *
 * **Example:** Milestone with Due Date
 * ```typescript
 * yield* GitHub.Milestone("sprint-1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Sprint 1",
 *   description: "Complete user authentication",
 *   dueOn: "2026-12-31",
 * });
 * ```
 *
 * ### Updating Milestones
 * Deploy with the same logical ID and different properties to update the
 * existing milestone in place.
 *
 * **Example:** Update Description and Due Date
 * ```typescript
 * yield* GitHub.Milestone("v2", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "v2.0.0",
 *   description: "Updated: API redesign and performance improvements",
 *   dueOn: "2027-06-30",
 * });
 * ```
 *
 * ### Closing and Reopening
 * **Example:** Close a Milestone
 * ```typescript
 * yield* GitHub.Milestone("v1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "v1.0.0",
 *   state: "closed",
 * });
 * ```
 *
 * **Example:** Reopen a Milestone
 * ```typescript
 * yield* GitHub.Milestone("v1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "v1.0.0",
 *   state: "open",
 * });
 * ```
 *
 * ### Replacing on Title Change
 * Changing the title creates a new milestone and deletes the old one.
 *
 * **Example:** Replace by Changing Title
 * ```typescript
 * // First deploy creates "Q1 2026"
 * const milestone = yield* GitHub.Milestone("q1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Q1 2026",
 * });
 *
 * // Later deploy with same logical ID but different title replaces it
 * const milestone = yield* GitHub.Milestone("q1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   title: "Q1 2027",
 * });
 * ```
 *
 * ### Wiring with Other Resources
 * **Example:** Create Repository with Milestone
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const repo = yield* GitHub.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 *   autoInit: true,
 * });
 *
 * yield* GitHub.Milestone("launch", {
 *   owner: repo.owner!,
 *   repository: Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!),
 *   title: "Initial Launch",
 *   dueOn: "2026-12-31",
 * });
 * ```
 *
 * @resource
 * @product Issue
 */
export const Milestone = Resource<Milestone>("GitHub.Milestone");

export const MilestoneProvider = () =>
  Provider.succeed(Milestone, {
    stables: ["milestoneNumber", "nodeId"],

    // A milestone belongs to (host, owner, repository, title) — changing any
    // of these replaces the resource.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.title !== olds.title ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(
      function* ({ news }) {
        const state = news.state ?? "open";
        const description = news.description ?? "";
        const requestedDueOn = news.dueOn;
        const dueOn =
          requestedDueOn === undefined
            ? null
            : yield* Effect.try(() => new Date(requestedDueOn).toISOString().replace(".000Z", "Z"));

        // Observe — probe for an existing milestone by title. GitHub's list
        // endpoint supports filtering by state, but we need to check both open
        // and closed to find any existing milestone with this title.
        const existingMilestones = yield* Stream.runCollect(
          Issues.listMilestones.items({
            owner: news.owner,
            repo: news.repository,
            state: "all",
            per_page: 100,
          }),
        );

        let observed = existingMilestones.find((m) => m.title === news.title);

        // Ensure — when no milestone exists, create one
        if (observed === undefined) {
          observed = yield* Issues.createMilestone({
            owner: news.owner,
            repo: news.repository,
            title: news.title,
            state,
            description,
            due_on: dueOn ?? undefined,
          });
        }

        // Creation can shift the due date; converge the returned state too.
        if (
          observed.state === state &&
          (observed.description ?? "") === description &&
          observed.due_on === dueOn
        ) {
          return attrsOf(observed);
        }

        return attrsOf(
          yield* Issues.updateMilestone({
            owner: news.owner,
            repo: news.repository,
            milestone_number: observed.number,
            title: news.title,
            state,
            description,
            due_on: dueOn,
          }),
        );
      },
      (effect, { news }) => effect.pipe(withBaseUrl(news.baseUrl)),
    ),

    // Enumerate every milestone across the repositories the token can see —
    // milestones are keyed by {owner, repository, title} with no account-wide
    // list endpoint, so walk the repos like the Variable provider does.
    list: Effect.fn(function* () {
      const repos = yield* Stream.runCollect(
        Repos.listForAuthenticatedUser.items({ per_page: 100 }),
      );
      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Stream.runCollect(
            Issues.listMilestones.items({
              owner: repo.owner.login,
              repo: repo.name,
              state: "all",
              per_page: 100,
            }),
          ).pipe(
            Effect.map((milestones) => milestones.map(attrsOf)),
            // Repos where the token lacks milestone access reject with 403/404 —
            // skip them rather than failing the whole enumeration.
            Effect.catchTag(["Forbidden", "NotFound"], () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return perRepo.flat();
    }),

    delete: Effect.fn(
      function* ({ olds, output }) {
        yield* Issues.deleteMilestone({
          owner: olds.owner,
          repo: olds.repository,
          milestone_number: output.milestoneNumber,
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      },
      (effect, { olds }) => effect.pipe(withBaseUrl(olds.baseUrl)),
    ),
  });

const attrsOf = (data: {
  number: number;
  node_id: string;
  title: string;
  state: "open" | "closed";
  description: string | null;
  due_on: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  open_issues: number;
  closed_issues: number;
}) => ({
  milestoneNumber: data.number,
  nodeId: data.node_id,
  title: data.title,
  state: data.state,
  description: data.description,
  dueOn: data.due_on,
  htmlUrl: data.html_url,
  createdAt: data.created_at,
  updatedAt: data.updated_at,
  closedAt: data.closed_at,
  openIssues: data.open_issues,
  closedIssues: data.closed_issues,
});
