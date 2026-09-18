import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface LabelProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Label name. The name is the label's identity — changing it replaces the
   * label.
   */
  name: string;

  /**
   * Label color (6-character hex code without the leading `#`).
   * @default "ededed"
   */
  color?: string;

  /**
   * Short description of the label.
   */
  description?: string;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Label extends Resource<
  "GitHub.Label",
  LabelProps,
  {
    /**
     * Numeric label ID.
     */
    labelId: number;

    /**
     * GraphQL node ID of the label.
     */
    nodeId: string;

    /**
     * The label name.
     */
    name: string;

    /**
     * The label color (6-character hex code without the leading `#`).
     */
    color: string;

    /**
     * Label description.
     */
    description: string | null;

    /**
     * URL to view the label in a browser.
     */
    url: string;

    /**
     * Whether this is a default label (created by GitHub).
     */
    default: boolean;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub repository label.
 *
 * `Label` manages repository labels for categorizing issues and pull requests.
 * Labels are created on first deploy and updated in place on subsequent
 * deploys when properties change.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 * ### Creating Labels
 * **Example:** Basic Label
 * ```typescript
 * const bug = yield* GitHub.Label("bug", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "bug",
 *   color: "d73a4a",
 *   description: "Something isn't working",
 * });
 * ```
 *
 * **Example:** Multiple Labels
 * ```typescript
 * yield* GitHub.Label("feature", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "feature",
 *   color: "a2eeef",
 *   description: "New feature or request",
 * });
 *
 * yield* GitHub.Label("documentation", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "documentation",
 *   color: "0075ca",
 *   description: "Improvements or additions to documentation",
 * });
 * ```
 *
 * ### Updating Labels
 * Deploy with the same logical ID and different properties to update the
 * existing label in place.
 *
 * **Example:** Update Color and Description
 * ```typescript
 * yield* GitHub.Label("priority-high", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "priority: high",
 *   color: "ff0000",
 *   description: "Updated: Critical issues requiring immediate attention",
 * });
 * ```
 *
 * ### Label Color Codes
 * GitHub uses 6-character hex codes without the `#` prefix. Common colors:
 * - `d73a4a` - Red (bugs)
 * - `0075ca` - Blue (documentation)
 * - `a2eeef` - Light blue (features)
 * - `7057ff` - Purple (good first issue)
 * - `008672` - Green (improvement)
 * - `e4e669` - Yellow (question)
 *
 * **Example:** Standard Label Set
 * ```typescript
 * const labels = [
 *   { name: "bug", color: "d73a4a", description: "Something isn't working" },
 *   { name: "enhancement", color: "a2eeef", description: "New feature" },
 *   { name: "documentation", color: "0075ca", description: "Documentation" },
 * ];
 *
 * for (const { name, color, description } of labels) {
 *   yield* GitHub.Label(name, {
 *     owner: "my-org",
 *     repository: "my-repo",
 *     name,
 *     color,
 *     description,
 *   });
 * }
 * ```
 *
 * ### Replacing on Name Change
 * Changing the name creates a new label and deletes the old one.
 *
 * **Example:** Replace by Changing Name
 * ```typescript
 * // First deploy creates "wip"
 * const label = yield* GitHub.Label("work", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "wip",
 *   color: "fbca04",
 * });
 *
 * // Later deploy with same logical ID but different name replaces it
 * const label = yield* GitHub.Label("work", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "in-progress",
 *   color: "fbca04",
 * });
 * ```
 *
 * ### Wiring with Other Resources
 * **Example:** Create Repository with Labels
 * ```typescript
 * const repo = yield* GitHub.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 *   autoInit: true,
 * });
 *
 * yield* GitHub.Label("bug", {
 *   owner: repo.owner!,
 *   repository: repo.name!,
 *   name: "bug",
 *   color: "d73a4a",
 * });
 * ```
 *
 * @resource
 */
export const Label = Resource<Label>("GitHub.Label");

export const LabelProvider = () =>
  Provider.succeed(Label, {
    stables: ["labelId", "nodeId"],

    // A label belongs to (host, owner, repository, name) — changing any of
    // these replaces the resource.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.name !== olds.name ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const octokit = yield* octokitFor(news.baseUrl);

      // Observe — probe for an existing label by name
      const observed = yield* Effect.tryPromise({
        try: async () => {
          try {
            const { data } = await octokit.rest.issues.getLabel({
              owner: news.owner,
              repo: news.repository,
              name: news.name,
            });
            return data;
          } catch (error: any) {
            if (error.status === 404) return undefined;
            throw error;
          }
        },
        catch: (e) => e as Error,
      });

      // Ensure — when no label exists, create one
      if (observed === undefined) {
        const { data } = yield* Effect.tryPromise({
          try: () =>
            octokit.rest.issues.createLabel({
              owner: news.owner,
              repo: news.repository,
              name: news.name,
              color: news.color,
              description: news.description,
            }),
          catch: (e) => e as Error,
        });

        return attrsOf(data);
      }

      // Sync — update the existing label if any properties differ
      const { data } = yield* Effect.tryPromise({
        try: () =>
          octokit.rest.issues.updateLabel({
            owner: news.owner,
            repo: news.repository,
            name: news.name,
            color: news.color,
            description: news.description,
          }),
        catch: (e) => e as Error,
      });

      return attrsOf(data);
    }),

    // Enumerate every label across the repositories the token can see —
    // labels are keyed by {owner, repository, name} with no account-wide
    // list endpoint, so walk the repos like the Variable provider does.
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
                const labels = await octokit.paginate(
                  octokit.rest.issues.listLabelsForRepo,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100,
                  },
                );
                return labels.map(attrsOf);
              } catch (error: any) {
                // Repos where the token lacks label access reject with
                // 403/404 — skip them rather than failing the whole enumeration.
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

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* octokitFor(olds.baseUrl);

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.issues.deleteLabel({
              owner: olds.owner,
              repo: olds.repository,
              name: olds.name,
            });
          } catch (error: any) {
            if (error.status !== 404) {
              throw error;
            }
          }
        },
        catch: (e) => e as Error,
      });
    }),
  });

const attrsOf = (data: {
  id: number;
  node_id: string;
  name: string;
  color: string;
  description: string | null;
  url: string;
  default: boolean;
}) => ({
  labelId: data.id,
  nodeId: data.node_id,
  name: data.name,
  color: data.color,
  description: data.description,
  url: data.url,
  default: data.default,
});
