import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface CollaboratorProps {
  /**
   * Repository owner — a user or organization login.
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * GitHub username to grant access.
   */
  username: string;

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

export interface Collaborator extends Resource<
  "GitHub.Collaborator",
  CollaboratorProps,
  {
    /**
     * GitHub username.
     */
    username: string;

    /**
     * Permission level granted.
     */
    permission: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub repository collaborator.
 *
 * `Collaborator` grants a user direct access to a repository. For
 * organization-owned repositories, prefer `GitHub.TeamAccess` to grant
 * access through teams instead of individual users.
 *
 * Collaborators default to **retain** on removal — destroying the stack does
 * NOT remove the collaborator, preventing accidental lockout. Opt in to
 * actual removal by wrapping the resource in {@link destroy}() from
 * `alchemy/RemovalPolicy`.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope (and `admin:repo` for removal when opted in via `destroy()`).
 *
 * ### Adding a Collaborator
 * **Example:** Grant Push Access
 * ```typescript
 * yield* GitHub.Collaborator("collaborator", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   username: "contributor",
 *   permission: "push",
 * })
 * ```
 *
 * **Example:** Grant Admin Access
 * ```typescript
 * yield* GitHub.Collaborator("admin", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   username: "team-lead",
 *   permission: "admin",
 * })
 * ```
 *
 * **Example:** Grant Read-Only Access
 * ```typescript
 * yield* GitHub.Collaborator("readonly", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   username: "auditor",
 *   permission: "pull",
 * })
 * ```
 *
 * ### Removing a Collaborator
 * **Example:** Allow Removal on Destroy
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy"
 *
 * yield* GitHub.Collaborator("temp", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   username: "contractor",
 *   permission: "push",
 * }).pipe(destroy())
 * ```
 *
 * @resource
 */
export const Collaborator = Resource<Collaborator>("GitHub.Collaborator", {
  defaultRemovalPolicy: "retain",
});

export const CollaboratorProvider = () =>
  Provider.succeed(Collaborator, {
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.username !== olds.username ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const octokit = yield* octokitFor(news.baseUrl);

      // Ensure & Sync — PUT is idempotent; creates or updates permission
      yield* Effect.tryPromise({
        try: async () => {
          await octokit.rest.repos.addCollaborator({
            owner: news.owner,
            repo: news.repository,
            username: news.username,
            permission: news.permission ?? "push",
          });
        },
        catch: (e) => e as Error,
      });

      return {
        username: news.username,
        permission: news.permission ?? "push",
      };
    }),

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
                const collaborators = await octokit.paginate(
                  octokit.rest.repos.listCollaborators,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100,
                  },
                );
                return collaborators.map((collab: any) => ({
                  username: collab.login,
                  permission: collab.permissions?.admin
                    ? "admin"
                    : collab.permissions?.maintain
                      ? "maintain"
                      : collab.permissions?.push
                        ? "push"
                        : collab.permissions?.triage
                          ? "triage"
                          : "pull",
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

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* octokitFor(olds.baseUrl);

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.repos.removeCollaborator({
              owner: olds.owner,
              repo: olds.repository,
              username: olds.username,
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
