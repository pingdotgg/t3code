import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface EnvironmentProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Environment name (e.g. `production`, `staging`). The name is the
   * environment's identity — changing it replaces the environment.
   */
  name: string;

  /**
   * Minutes to wait before allowing deployments to proceed (0–43200,
   * i.e. up to 30 days). Requires a plan that supports environment
   * protection rules on the repository.
   * @default 0
   */
  waitTimer?: number;

  /**
   * Whether users who created or pushed the deployment are prevented
   * from approving their own deployment.
   * @default false
   */
  preventSelfReview?: boolean;

  /**
   * The people or teams that must review deployments to this environment.
   * Up to six users or teams in total; reviewers must have at least read
   * access to the repository. Users are referenced by login, teams by
   * slug (teams are only valid for organization-owned repositories).
   */
  reviewers?: {
    /**
     * User logins allowed to review deployments.
     */
    users?: string[];

    /**
     * Team slugs (within the owning organization) allowed to review
     * deployments.
     */
    teams?: string[];
  };

  /**
   * Which branches can deploy to this environment. Omit to allow all
   * branches. Set `protectedBranches: true` to restrict deployments to
   * branches with branch protection rules, or `customBranchPolicies` to a
   * list of branch name patterns (e.g. `["main", "release/*"]`).
   */
  deploymentBranchPolicy?:
    | { protectedBranches: true }
    | { customBranchPolicies: string[] };

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Environment extends Resource<
  "GitHub.Environment",
  EnvironmentProps,
  {
    /**
     * Numeric GitHub environment ID.
     */
    environmentId: number;

    /**
     * GraphQL node ID of the environment.
     */
    nodeId: string;

    /**
     * The environment name.
     */
    name: string;

    /**
     * URL to view the environment in a browser.
     */
    htmlUrl: string;

    /**
     * ISO-8601 timestamp of when the environment was created.
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
 * A GitHub Actions deployment environment.
 *
 * `Environment` manages a repository's deployment environment (e.g.
 * `production`, `staging`) along with its protection rules: required
 * reviewers, wait timers, self-review prevention, and deployment branch
 * policies. Pair it with `GitHub.Secret` and `GitHub.Variable` (both accept
 * an `environment` prop) to scope configuration to the environment.
 *
 * Environments are available on public repositories on every plan; private
 * repositories require GitHub Pro, Team, or Enterprise, and protection
 * rules on private repositories require Team or Enterprise.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied
 * by `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token
 * needs `repo` scope.
 * @resource
 * @section Creating an Environment
 * @example Basic Environment
 * ```typescript
 * const production = yield* GitHub.Environment("production", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "production",
 * });
 * ```
 *
 * @example Environment with Protection Rules
 * ```typescript
 * yield* GitHub.Environment("production", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "production",
 *   waitTimer: 30,
 *   preventSelfReview: true,
 *   reviewers: {
 *     users: ["release-manager"],
 *     teams: ["platform"],
 *   },
 * });
 * ```
 *
 * @section Deployment Branch Policies
 * @example Restrict to Protected Branches
 * ```typescript
 * yield* GitHub.Environment("production", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "production",
 *   deploymentBranchPolicy: { protectedBranches: true },
 * });
 * ```
 *
 * @example Restrict to Branch Name Patterns
 * ```typescript
 * yield* GitHub.Environment("production", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "production",
 *   deploymentBranchPolicy: {
 *     customBranchPolicies: ["main", "release/*"],
 *   },
 * });
 * ```
 *
 * @section Environment Secrets and Variables
 * @example Scope Secrets and Variables to the Environment
 * ```typescript
 * const env = yield* GitHub.Environment("production", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "production",
 * });
 *
 * yield* GitHub.Secret("deploy-key", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: env,
 *   name: "DEPLOY_KEY",
 *   value: Redacted.make("my-secret-value"),
 * });
 *
 * yield* GitHub.Variable("region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: env,
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 * ```
 */
export const Environment = Resource<Environment>("GitHub.Environment");

// At runtime, Resource references in props are resolved to their full
// attributes — so an `Environment` passed to another resource's
// `environment` prop arrives as `{ name: string; ... }` rather than the
// statically-typed Resource (whose attributes are `Output<...>`). We cast
// through the structural shape here.
export const resolveEnvironmentName = (
  environment: string | Environment | undefined,
): string | undefined => {
  const ref = environment as unknown as string | { name: string } | undefined;
  return ref === undefined
    ? undefined
    : typeof ref === "string"
      ? ref
      : ref.name;
};

export const EnvironmentProvider = () =>
  Provider.succeed(Environment, {
    stables: ["environmentId", "nodeId"],

    // The environment name is its path identity — GitHub has no rename, so
    // changing owner, repository, name, or the host replaces the resource.
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

      // Resolve reviewer logins/slugs to the numeric IDs the API expects.
      const reviewers = yield* Effect.tryPromise({
        try: async () => {
          if (news.reviewers === undefined) return null;
          const users = await Promise.all(
            (news.reviewers.users ?? []).map(async (username) => {
              const { data } = await octokit.rest.users.getByUsername({
                username,
              });
              return { type: "User" as const, id: data.id };
            }),
          );
          const teams = await Promise.all(
            (news.reviewers.teams ?? []).map(async (team_slug) => {
              const { data } = await octokit.rest.teams.getByName({
                org: news.owner,
                team_slug,
              });
              return { type: "Team" as const, id: data.id };
            }),
          );
          return [...users, ...teams];
        },
        catch: (e) => e as Error,
      });

      // Ensure & Sync — the PUT is a full upsert of the environment's
      // protection configuration; send explicit values (not omissions) so
      // removed props converge back to their defaults.
      const environment = yield* Effect.tryPromise({
        try: async () => {
          const { data } = await octokit.rest.repos.createOrUpdateEnvironment({
            owner: news.owner,
            repo: news.repository,
            environment_name: news.name,
            wait_timer: news.waitTimer ?? 0,
            prevent_self_review: news.preventSelfReview ?? false,
            reviewers:
              reviewers === null || reviewers.length === 0 ? null : reviewers,
            deployment_branch_policy:
              news.deploymentBranchPolicy === undefined
                ? null
                : "protectedBranches" in news.deploymentBranchPolicy
                  ? { protected_branches: true, custom_branch_policies: false }
                  : { protected_branches: false, custom_branch_policies: true },
          });
          return data;
        },
        catch: (e) => e as Error,
      });

      // Sync — custom branch policies live behind dedicated endpoints. Diff
      // the observed patterns against the desired list; create the missing
      // ones and delete the extras. Skipped entirely unless the policy mode
      // is custom (GitHub drops the policies itself when the mode changes).
      if (
        news.deploymentBranchPolicy !== undefined &&
        "customBranchPolicies" in news.deploymentBranchPolicy
      ) {
        const desired = news.deploymentBranchPolicy.customBranchPolicies;
        yield* Effect.tryPromise({
          try: async () => {
            const observed = await octokit.paginate(
              octokit.rest.repos.listDeploymentBranchPolicies,
              {
                owner: news.owner,
                repo: news.repository,
                environment_name: news.name,
                per_page: 100,
              },
            );
            const observedNames = new Set(
              observed.map((policy) => policy.name),
            );
            for (const name of desired) {
              if (!observedNames.has(name)) {
                await octokit.rest.repos.createDeploymentBranchPolicy({
                  owner: news.owner,
                  repo: news.repository,
                  environment_name: news.name,
                  name,
                  type: "branch",
                });
              }
            }
            for (const policy of observed) {
              if (
                policy.id !== undefined &&
                policy.name !== undefined &&
                !desired.includes(policy.name)
              ) {
                await octokit.rest.repos.deleteDeploymentBranchPolicy({
                  owner: news.owner,
                  repo: news.repository,
                  environment_name: news.name,
                  branch_policy_id: policy.id,
                });
              }
            }
          },
          catch: (e) => e as Error,
        });
      }

      return {
        environmentId: environment.id,
        nodeId: environment.node_id,
        name: environment.name,
        htmlUrl: environment.html_url,
        createdAt: environment.created_at,
        updatedAt: environment.updated_at,
      };
    }),

    // Enumerate every environment across the repositories the token can see —
    // environments are keyed by {owner, repository, name} with no account-wide
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
                // `octokit.paginate` can't flatten this endpoint's
                // `{ total_count, environments }` envelope, so page manually
                // until a short page signals the end.
                const environments = [];
                for (let page = 1; ; page++) {
                  const { data } = await octokit.rest.repos.getAllEnvironments({
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100,
                    page,
                  });
                  const batch = data.environments ?? [];
                  environments.push(
                    ...batch.map((environment) => ({
                      environmentId: environment.id,
                      nodeId: environment.node_id,
                      name: environment.name,
                      htmlUrl: environment.html_url,
                      createdAt: environment.created_at,
                      updatedAt: environment.updated_at,
                    })),
                  );
                  if (batch.length < 100) break;
                }
                return environments;
              } catch (error: any) {
                // Repos without environments support (plan limits) or where
                // the token lacks access reject with 403/404 — skip them
                // rather than failing the whole enumeration.
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
            await octokit.rest.repos.deleteAnEnvironment({
              owner: olds.owner,
              repo: olds.repository,
              environment_name: olds.name,
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
