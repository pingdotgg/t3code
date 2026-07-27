import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface RepositoryProps {
  /**
   * Repository owner — a user or organization login.
   *
   * Changing the owner replaces the repository: a NEW, EMPTY repository is
   * created under the new owner — history, issues, and pull requests are
   * not carried over. The old repository is retained on GitHub under the
   * default `retain` removal policy; it is only deleted when the resource
   * opted into deletion via `destroy()`. To actually move a repository
   * between owners with its history, transfer it in the GitHub UI/API
   * first, then update `owner` here and deploy with `--adopt`.
   */
  owner: string;

  /**
   * Repository name. Renaming (deploying with the same logical ID and a
   * different `name`) renames the existing repository in place rather than
   * replacing it.
   */
  name: string;

  /**
   * Short description shown on the repository page.
   */
  description?: string;

  /**
   * Homepage URL shown on the repository page.
   */
  homepage?: string;

  /**
   * Repository visibility. `internal` is only valid for repositories owned by
   * an organization on GitHub Enterprise. When omitted, GitHub's default
   * applies (`public`).
   * @default "public"
   */
  visibility?: "public" | "private" | "internal";

  /**
   * Whether the Issues tab is enabled.
   * @default true
   */
  hasIssues?: boolean;

  /**
   * Whether the Projects tab is enabled.
   * @default true
   */
  hasProjects?: boolean;

  /**
   * Whether the Wiki tab is enabled.
   * @default true
   */
  hasWiki?: boolean;

  /**
   * Whether GitHub Discussions are enabled.
   * @default false
   */
  hasDiscussions?: boolean;

  /**
   * Whether the repository is a template repository.
   * @default false
   */
  isTemplate?: boolean;

  /**
   * Whether the repository is archived (read-only).
   * @default false
   */
  archived?: boolean;

  /**
   * The default branch name. Only applied to repositories that already have
   * at least one branch — setting it on an empty repository has no effect.
   */
  defaultBranch?: string;

  /**
   * Whether squash merges are allowed.
   * @default true
   */
  allowSquashMerge?: boolean;

  /**
   * Whether merge commits are allowed.
   * @default true
   */
  allowMergeCommit?: boolean;

  /**
   * Whether rebase merges are allowed.
   * @default true
   */
  allowRebaseMerge?: boolean;

  /**
   * Whether auto-merge is enabled for pull requests.
   * @default false
   */
  allowAutoMerge?: boolean;

  /**
   * Whether head branches are automatically deleted after a pull request is
   * merged.
   * @default false
   */
  deleteBranchOnMerge?: boolean;

  /**
   * Repository topics. The provided list fully replaces the existing topics.
   */
  topics?: string[];

  /**
   * Initialize the repository with an empty README on creation. Only used at
   * create time — ignored on subsequent updates.
   * @default false
   */
  autoInit?: boolean;

  /**
   * Name of the `.gitignore` template to apply on creation (e.g. `"Node"`).
   * Only used at create time.
   */
  gitignoreTemplate?: string;

  /**
   * Keyword of the license template to apply on creation (e.g. `"mit"`).
   * Only used at create time.
   */
  licenseTemplate?: string;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Repository extends Resource<
  "GitHub.Repository",
  RepositoryProps,
  {
    /**
     * Numeric GitHub repository ID.
     */
    repoId: number;

    /**
     * GraphQL node ID of the repository.
     */
    nodeId: string;

    /**
     * Full name in `owner/name` form.
     */
    fullName: string;

    /**
     * URL to view the repository in a browser.
     */
    htmlUrl: string;

    /**
     * Git protocol clone URL (`git://`).
     */
    gitUrl: string;

    /**
     * SSH clone URL (`git@github.com:owner/name.git`).
     */
    sshUrl: string;

    /**
     * HTTPS clone URL.
     */
    cloneUrl: string;

    /**
     * The resolved default branch name.
     */
    defaultBranch: string;

    /**
     * ISO-8601 timestamp of when the repository was created.
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
 * A GitHub repository.
 *
 * `Repository` manages the lifecycle of a repository owned by a user or
 * organization. The repository is created on first deploy and its settings are
 * converged on every subsequent deploy.
 *
 * Repositories default to **retain** on removal — destroying the stack does
 * NOT delete the repository on GitHub, protecting its irreplaceable history
 * (issues, pull requests, commits). Opt in to actual deletion by wrapping the
 * resource (or the whole stack) in {@link destroy}() from
 * `alchemy/RemovalPolicy`.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope (and `delete_repo` when deletion is opted in via `destroy()`).
 * @resource
 * @section Creating a Repository
 * @example Basic Repository
 * ```typescript
 * const repo = yield* GitHub.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 *   description: "API service",
 *   autoInit: true,
 * });
 * ```
 *
 * @example Private Repository with Settings
 * ```typescript
 * const repo = yield* GitHub.Repository("internal-tools", {
 *   owner: "my-org",
 *   name: "internal-tools",
 *   visibility: "private",
 *   hasWiki: false,
 *   hasProjects: false,
 *   deleteBranchOnMerge: true,
 * });
 * ```
 *
 * @example Initialize from Templates
 * The `autoInit`, `gitignoreTemplate`, and `licenseTemplate` props seed the
 * first commit. They are only honored at create time — changing them on a
 * later deploy has no effect on an existing repository.
 * ```typescript
 * const repo = yield* GitHub.Repository("service", {
 *   owner: "my-org",
 *   name: "service",
 *   autoInit: true,
 *   gitignoreTemplate: "Node",
 *   licenseTemplate: "mit",
 * });
 * ```
 *
 * @section Topics and Merge Configuration
 * @example Repository with Topics and Merge Policy
 * ```typescript
 * const repo = yield* GitHub.Repository("sdk", {
 *   owner: "my-org",
 *   name: "sdk",
 *   topics: ["typescript", "effect", "sdk"],
 *   allowMergeCommit: false,
 *   allowRebaseMerge: false,
 *   allowSquashMerge: true,
 *   allowAutoMerge: true,
 * });
 * ```
 *
 * @section Renaming a Repository
 * @example Rename in Place
 * Keep the same logical ID and change `name` to rename the live repository
 * instead of replacing it — the repository's history, issues, and pull
 * requests are preserved. Only changing `owner` triggers a replacement.
 * ```typescript
 * // First deploy creates "api".
 * const repo = yield* GitHub.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 * });
 *
 * // A later deploy with the SAME logical ID ("api") renames it to "gateway".
 * const repo = yield* GitHub.Repository("api", {
 *   owner: "my-org",
 *   name: "gateway",
 * });
 * ```
 *
 * @section Archiving a Repository
 * @example Make a Repository Read-Only
 * Archiving sets the repository to read-only. Set `archived` back to `false`
 * on a later deploy to un-archive it.
 * ```typescript
 * yield* GitHub.Repository("legacy", {
 *   owner: "my-org",
 *   name: "legacy-service",
 *   archived: true,
 * });
 * ```
 *
 * @section Wiring with Other Resources
 * The repository's outputs can drive other GitHub resources so the whole
 * repository configuration lives in one program.
 *
 * @example Seed a Variable into the Repository
 * ```typescript
 * const repo = yield* GitHub.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 *   autoInit: true,
 * });
 *
 * yield* GitHub.Variable("region", {
 *   owner: "my-org",
 *   repository: repo.name!,
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 * ```
 *
 * @example Store a Secret in the Repository
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const repo = yield* GitHub.Repository("api", {
 *   owner: "my-org",
 *   name: "api",
 *   autoInit: true,
 * });
 *
 * yield* GitHub.Secret("deploy-token", {
 *   owner: "my-org",
 *   repository: repo.name!,
 *   name: "DEPLOY_TOKEN",
 *   value: Redacted.make("my-secret-value"),
 * });
 * ```
 *
 * @section Deleting a Repository
 * @example Allow Repository Deletion
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy";
 *
 * yield* GitHub.Repository("ephemeral", {
 *   owner: "my-org",
 *   name: "ephemeral-preview",
 * }).pipe(destroy());
 * ```
 */
export const Repository = Resource<Repository>("GitHub.Repository", {
  defaultRemovalPolicy: "retain",
});

export const RepositoryProvider = () =>
  Provider.succeed(Repository, {
    stables: ["repoId", "nodeId"],

    // Structural changes are the owner (we deliberately do NOT call GitHub's
    // transfer API — user-to-user transfers require out-of-band acceptance
    // and cannot converge deterministically) and the host (the same repo
    // name on a different GitHub instance is a different repository). A
    // `name` change is a rename, handled in `reconcile`, not a replacement.
    //
    // Replacement is guarded by the resource's default `retain` removal
    // policy: the engine creates the new repository and RETAINS the old one
    // on GitHub (Apply honors `retain` for the replaced old generation), so
    // history is never destroyed unless the user opted into `destroy()`.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const octokit = yield* octokitFor(news.baseUrl);

      const getRepo = (repo: string) =>
        Effect.tryPromise({
          try: async () => {
            try {
              const { data } = await octokit.rest.repos.get({
                owner: news.owner,
                repo,
              });
              return data;
            } catch (error: any) {
              if (error.status === 404) return undefined;
              throw error;
            }
          },
          catch: (e) => e as Error,
        });

      // Observe — probe for the live repository under the desired name. On a
      // rename (name changed since last deploy) the desired name 404s, so fall
      // back to the prior name so we converge by renaming rather than creating
      // a duplicate.
      let observed = yield* getRepo(news.name);
      if (
        observed === undefined &&
        olds?.name !== undefined &&
        olds.name !== news.name
      ) {
        observed = yield* getRepo(olds.name);
      }

      // Ensure — create the repository when it does not exist. The owner may be
      // a user or an organization; pick the matching create endpoint.
      if (observed === undefined) {
        const ownerType = yield* Effect.tryPromise({
          try: async () => {
            const { data } = await octokit.rest.users.getByUsername({
              username: news.owner,
            });
            return data.type;
          },
          catch: (e) => e as Error,
        });

        const createInput = {
          name: news.name,
          description: news.description,
          homepage: news.homepage,
          has_issues: news.hasIssues,
          has_projects: news.hasProjects,
          has_wiki: news.hasWiki,
          is_template: news.isTemplate,
          auto_init: news.autoInit,
          gitignore_template: news.gitignoreTemplate,
          license_template: news.licenseTemplate,
          allow_squash_merge: news.allowSquashMerge,
          allow_merge_commit: news.allowMergeCommit,
          allow_rebase_merge: news.allowRebaseMerge,
          allow_auto_merge: news.allowAutoMerge,
          delete_branch_on_merge: news.deleteBranchOnMerge,
        };

        observed = yield* Effect.tryPromise({
          try: async () => {
            try {
              const { data } =
                ownerType === "Organization"
                  ? // The org endpoint accepts `visibility` directly, which is
                    // the sole authority over public/private/internal. `internal`
                    // is only valid here.
                    await octokit.rest.repos.createInOrg({
                      org: news.owner,
                      ...createInput,
                      visibility: news.visibility,
                    } as Parameters<typeof octokit.rest.repos.createInOrg>[0])
                  : // A personal account is either a `User` or a `Bot`; both
                    // create through the authenticated-user endpoint, which only
                    // understands the boolean `private` flag.
                    await octokit.rest.repos.createForAuthenticatedUser({
                      ...createInput,
                      private: news.visibility
                        ? news.visibility !== "public"
                        : undefined,
                    } as Parameters<
                      typeof octokit.rest.repos.createForAuthenticatedUser
                    >[0]);
              return data;
            } catch (error: any) {
              // A 422 means the name already exists — treat as a create race
              // and re-observe so the sync step converges its settings.
              if (error.status === 422) return undefined;
              throw error;
            }
          },
          catch: (e) => e as Error,
        });

        if (observed === undefined) {
          observed = yield* getRepo(news.name);
        }
        if (observed === undefined) {
          return yield* Effect.fail(
            new Error(
              `Failed to create or locate GitHub repository ${news.owner}/${news.name}`,
            ),
          );
        }
      }

      // Sync — converge settings (and the name on a rename) against the live
      // repository. GitHub's update is an idempotent PATCH, so we always issue
      // it with the desired settings. `archived` is applied in a separate,
      // later PATCH because an archived repository rejects any other settings
      // change in the same call.
      const repoName = observed.name;
      const updateInput = {
        owner: news.owner,
        repo: repoName,
        name: news.name,
        description: news.description,
        homepage: news.homepage,
        private: news.visibility ? news.visibility !== "public" : undefined,
        visibility: news.visibility,
        has_issues: news.hasIssues,
        has_projects: news.hasProjects,
        has_wiki: news.hasWiki,
        has_discussions: news.hasDiscussions,
        is_template: news.isTemplate,
        allow_squash_merge: news.allowSquashMerge,
        allow_merge_commit: news.allowMergeCommit,
        allow_rebase_merge: news.allowRebaseMerge,
        allow_auto_merge: news.allowAutoMerge,
        delete_branch_on_merge: news.deleteBranchOnMerge,
        // Only set the default branch when it actually differs from the
        // observed branch. GitHub returns 422 if the branch does not yet
        // exist (e.g. an empty repo), so the 422 handler below strips it and
        // retries rather than hard-failing — the branch may be created right
        // after this deploy.
        default_branch:
          news.defaultBranch !== undefined &&
          observed.default_branch !== news.defaultBranch
            ? news.defaultBranch
            : undefined,
      };

      const updated = yield* Effect.tryPromise({
        // Octokit's typed params lag the REST API: `visibility: "internal"`
        // and `has_discussions` are valid at runtime but missing from the
        // generated types, so assert to the accepted parameter shape.
        try: async () => {
          try {
            const { data } = await octokit.rest.repos.update(
              updateInput as Parameters<typeof octokit.rest.repos.update>[0],
            );
            return data;
          } catch (error: any) {
            // A 422 on a default-branch update usually means the branch does
            // not exist yet. Drop it and retry so the rest of the settings
            // still converge.
            if (error.status === 422 && updateInput.default_branch) {
              const { default_branch, ...withoutBranch } = updateInput;
              const { data } = await octokit.rest.repos.update(
                withoutBranch as Parameters<
                  typeof octokit.rest.repos.update
                >[0],
              );
              return data;
            }
            throw error;
          }
        },
        catch: (e) => e as Error,
      });

      // Sync — apply `archived` in its own PATCH. Use the confirmed
      // post-rename name from the first update so the call targets the right
      // repo. Archiving is one-directional in this PATCH: only send it when
      // explicitly provided.
      if (news.archived !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            octokit.rest.repos.update({
              owner: news.owner,
              repo: updated.name,
              archived: news.archived,
            } as Parameters<typeof octokit.rest.repos.update>[0]),
          catch: (e) => e as Error,
        });
      }

      // Sync — topics are managed via a dedicated endpoint. The provided list
      // fully replaces existing topics, so removing the field (defined -> undefined)
      // must clear them. Use the confirmed post-rename name from the first PATCH.
      if (news.topics !== undefined || olds?.topics !== undefined) {
        yield* Effect.tryPromise({
          try: () =>
            octokit.rest.repos.replaceAllTopics({
              owner: news.owner,
              repo: updated.name,
              names: news.topics ?? [],
            }),
          catch: (e) => e as Error,
        });
      }

      return attrsOf(updated);
    }),

    // Enumerate every repository the authenticated token can see. GitHub has no
    // account/region scope resolved from env services — the ambient scope is the
    // token itself, so we list the authenticated user's repositories (across all
    // owners/orgs the token is a member of). `octokit.paginate` walks every page
    // exhaustively. Each list item is a full repository object, so it hydrates
    // directly into the same `Attributes` shape `read` returns.
    list: Effect.fn(function* () {
      const octokit = yield* Octokit;

      const repos = yield* Effect.tryPromise({
        try: () =>
          octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
            per_page: 100,
          }),
        catch: (e) => e as Error,
      });

      return repos.map((repo) =>
        attrsOf(repo as Parameters<typeof attrsOf>[0]),
      );
    }),

    // Read by the numeric repository ID, which is stable across renames. This
    // refreshes the output attributes (including the current name) so that a
    // subsequent delete targets the live repository even when a prior rename's
    // state persistence failed.
    read: Effect.fn(function* ({ olds, output }) {
      if (output === undefined) {
        return undefined;
      }

      const octokit = yield* octokitFor(olds.baseUrl);

      return yield* Effect.tryPromise({
        try: async () => {
          try {
            const { data } = await octokit.request("GET /repositories/{id}", {
              id: output.repoId,
            });
            return attrsOf(data as Parameters<typeof attrsOf>[0]);
          } catch (error: any) {
            if (error.status === 404) return undefined;
            throw error;
          }
        },
        catch: (e) => e as Error,
      });
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);

      // Resolve the current repository name via the stable numeric ID. A rename
      // whose state persistence failed leaves `olds.name` stale; deleting by
      // the stale name 404s and silently leaves the repo behind. Looking it up
      // by `repoId` gives us the live name.
      let owner = olds.owner;
      let repo = olds.name;
      if (output?.repoId !== undefined) {
        const current = yield* Effect.tryPromise({
          try: async () => {
            try {
              const { data } = await octokit.request("GET /repositories/{id}", {
                id: output.repoId,
              });
              return data;
            } catch (error: any) {
              if (error.status === 404) return undefined;
              throw error;
            }
          },
          catch: (e) => e as Error,
        });
        if (current !== undefined) {
          owner = current.owner.login;
          repo = current.name;
        }
      }

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.repos.delete({ owner, repo });
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
  full_name: string;
  html_url: string;
  git_url: string;
  ssh_url: string;
  clone_url: string;
  default_branch: string;
  created_at: string | null;
  updated_at: string | null;
}) => ({
  repoId: data.id,
  nodeId: data.node_id,
  fullName: data.full_name,
  htmlUrl: data.html_url,
  gitUrl: data.git_url,
  sshUrl: data.ssh_url,
  cloneUrl: data.clone_url,
  defaultBranch: data.default_branch,
  createdAt: data.created_at ?? new Date().toISOString(),
  updatedAt: data.updated_at ?? new Date().toISOString(),
});
