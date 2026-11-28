import * as Repos from "@distilled.cloud/github/repos";
import * as Teams from "@distilled.cloud/github/teams";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { withBaseUrl, gitHubBaseUrlChanged } from "./BaseUrl.ts";
import type * as GitHub from "./Providers.ts";

export interface TeamAccessProps {
  /**
   * Repository owner — must be an organization login.
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Team slug within the organization (e.g. `platform`, `frontend`).
   */
  teamSlug: string;

  /**
   * Permission level to grant.
   * - `pull` — read-only access
   * - `push` — read and write access
   * - `maintain` — read, write, and manage issues/PRs
   * - `triage` — read and manage issues/PRs without write access
   * - `admin` — full admin access
   *
   * @default "push"
   */
  permission?: "pull" | "push" | "maintain" | "triage" | "admin";

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface TeamAccess extends Resource<
  "GitHub.TeamAccess",
  TeamAccessProps,
  {
    /**
     * Team slug.
     */
    teamSlug: string;

    /**
     * Permission level granted.
     */
    permission: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub team repository access grant.
 *
 * `TeamAccess` grants a team access to a repository within an organization.
 * Teams provide a scalable way to manage repository permissions — add users
 * to teams instead of granting individual collaborator access.
 *
 * Team access grants default to **retain** on removal — destroying the stack
 * does NOT remove the team's access, preventing accidental lockout. Opt in
 * to actual removal by wrapping the resource in {@link destroy}() from
 * `alchemy/RemovalPolicy`.
 *
 * Authentication is resolved via the GitHub `Credentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope and `admin:org` for managing team access.
 *
 * ### Granting Team Access
 * **Example:** Grant Push Access to a Team
 * ```typescript
 * yield* GitHub.TeamAccess("platform-access", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   teamSlug: "platform",
 *   permission: "push",
 * })
 * ```
 *
 * **Example:** Grant Admin Access to a Team
 * ```typescript
 * yield* GitHub.TeamAccess("admin-access", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   teamSlug: "admins",
 *   permission: "admin",
 * })
 * ```
 *
 * **Example:** Grant Read-Only Access
 * ```typescript
 * yield* GitHub.TeamAccess("readonly", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   teamSlug: "contractors",
 *   permission: "pull",
 * })
 * ```
 *
 * ### Multiple Teams
 * **Example:** Grant Different Permissions to Multiple Teams
 * ```typescript
 * yield* GitHub.TeamAccess("platform-write", {
 *   owner: "my-org",
 *   repository: "api",
 *   teamSlug: "platform",
 *   permission: "push",
 * })
 *
 * yield* GitHub.TeamAccess("security-read", {
 *   owner: "my-org",
 *   repository: "api",
 *   teamSlug: "security",
 *   permission: "pull",
 * })
 * ```
 *
 * ### Removing Team Access
 * **Example:** Allow Removal on Destroy
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy"
 *
 * yield* GitHub.TeamAccess("temp", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   teamSlug: "contractors",
 *   permission: "push",
 * }).pipe(destroy())
 * ```
 *
 * @resource
 * @product Repository
 */
export const TeamAccess = Resource<TeamAccess>("GitHub.TeamAccess", {
  defaultRemovalPolicy: "retain",
});

export const TeamAccessProvider = () =>
  Provider.succeed(TeamAccess, {
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.teamSlug !== olds.teamSlug ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(
      function* ({ news }) {
        // Ensure & Sync — PUT is idempotent; adds team or updates permission
        yield* Teams.addOrUpdateRepoPermissionsInOrg({
          org: news.owner,
          team_slug: news.teamSlug,
          owner: news.owner,
          repo: news.repository,
          permission: news.permission ?? "push",
        });

        return {
          teamSlug: news.teamSlug,
          permission: news.permission ?? "push",
        };
      },
      (effect, { news }) => effect.pipe(withBaseUrl(news.baseUrl)),
    ),

    list: Effect.fn(function* () {
      const repos = yield* Stream.runCollect(
        Repos.listForAuthenticatedUser.items({ per_page: 100 }),
      );
      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Stream.runCollect(
            Repos.listTeams.items({
              owner: repo.owner.login,
              repo: repo.name,
              per_page: 100,
            }),
          ).pipe(
            Effect.map((teams) =>
              teams.map((team) => ({
                teamSlug: team.slug,
                permission: (team.permission ?? "push") as NonNullable<
                  TeamAccessProps["permission"]
                >,
              })),
            ),
            Effect.catchTag(["Forbidden", "NotFound"], () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return perRepo.flat();
    }),

    delete: Effect.fn(
      function* ({ olds }) {
        yield* Teams.removeRepoInOrg({
          org: olds.owner,
          team_slug: olds.teamSlug,
          owner: olds.owner,
          repo: olds.repository,
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      },
      (effect, { olds }) => effect.pipe(withBaseUrl(olds.baseUrl)),
    ),
  });
