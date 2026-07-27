import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { type Environment, resolveEnvironmentName } from "./Environment.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface VariableProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Variable name (e.g. `AWS_ROLE_ARN`).
   */
  name: string;

  /**
   * Variable value.
   */
  value: string;

  /**
   * Optional environment. When set the variable is scoped to that GitHub
   * Actions environment instead of the whole repository. Accepts an
   * environment name or a `GitHub.Environment` resource.
   */
  environment?: string | Environment;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Variable extends Resource<
  "GitHub.Variable",
  VariableProps,
  {
    /**
     * ISO-8601 timestamp of the last update.
     */
    updatedAt: string;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub Actions repository variable.
 *
 * `Variable` manages the lifecycle of a plain-text configuration variable
 * in GitHub Actions. Variables are visible in workflow logs and are
 * suitable for non-sensitive configuration like region names, environment
 * labels, or feature flags. For sensitive values, use `GitHub.Secret`
 * instead.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied
 * by `GitHub.providers()` (which uses the Alchemy AuthProvider — env,
 * stored PAT, `gh` CLI, or OAuth). The token needs `repo` scope for
 * private repositories or `public_repo` for public ones.
 * @resource
 * @section Repository Variables
 * Store variables accessible to all GitHub Actions workflows in the
 * repository.
 *
 * @example Create a Repository Variable
 * ```typescript
 * yield* GitHub.Variable("aws-region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 * ```
 *
 * @section Environment Variables
 * Scope a variable to a specific GitHub Actions environment (e.g.
 * `production`, `staging`). Use `GitHub.Environment` to manage the
 * environment itself.
 *
 * @example Create an Environment Variable
 * ```typescript
 * yield* GitHub.Variable("region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: "production",
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 * ```
 *
 * @section Wiring with Other Resources
 * Pass output attributes from other resources into GitHub variables so
 * that CI workflows can reference them.
 *
 * @example Store a Worker URL for CI
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Api", { ... });
 *
 * yield* GitHub.Variable("api-url", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "API_URL",
 *   value: worker.url!,
 * });
 * ```
 *
 * @example Multiple Variables
 * ```typescript
 * yield* GitHub.Variable("region", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_REGION",
 *   value: "us-east-1",
 * });
 *
 * yield* GitHub.Variable("stage", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "DEPLOY_STAGE",
 *   value: "production",
 * });
 * ```
 */
export const Variable = Resource<Variable>("GitHub.Variable");

export const VariableProvider = () =>
  Provider.succeed(Variable, {
    // A variable's entire identity is (host, owner, repository, environment,
    // name) — GitHub has no rename/move API for variables, so changing any
    // of them replaces the resource: the engine creates the new variable
    // first, then `delete` removes the old one from its old location.
    // Replacement is safe here — a variable is declarative config that is
    // fully re-creatable from props.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.name !== olds.name ||
        resolveEnvironmentName(news.environment) !==
          resolveEnvironmentName(olds.environment) ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      // A variable is keyed by its location (repo vs. environment). A
      // location change normally arrives as a replacement (see `diff`); this
      // guard is the safety net for the plan-time path where `news` contained
      // unresolved outputs and diff could not compare — delete the orphaned
      // variable from its old location before converging the new one.
      if (
        olds !== undefined &&
        resolveEnvironmentName(olds.environment) !==
          resolveEnvironmentName(news.environment)
      ) {
        yield* deleteVariable(olds);
      }

      // Observe — `name` is the path identifier; ask GitHub directly for the
      // live row. A 404 means it doesn't exist (deleted out-of-band, or never
      // created), so we converge by creating it; otherwise we PATCH the value.
      const observed = yield* getVariable(news);

      // Ensure — POST creates the variable.
      if (observed === undefined) {
        yield* createVariable(news);
        return { updatedAt: new Date().toISOString() };
      }

      // Sync — PATCH the value if it drifted; skip the call when the
      // observed value already matches to keep the API quiet.
      if (observed.value !== news.value) {
        yield* updateVariable(news);
      }
      return { updatedAt: new Date().toISOString() };
    }),

    // Enumerate every Actions variable visible to the authenticated token.
    // GitHub variables are keyed by {owner, repository, name} and there is no
    // account-wide "list all variables" endpoint, so the ambient scope is the
    // authenticated account: list every repository the token can see, then
    // exhaustively paginate each repo's variables and hydrate into the same
    // `Attributes` shape `reconcile` returns. Variable values are readable
    // (unlike secrets), but the resource's `Attributes` only exposes
    // `updatedAt`, so that's all we surface here.
    list: Effect.fn(function* () {
      const octokit = yield* Octokit;

      // `octokit.paginate` walks every page and flattens to a single array.
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
                const variables = await octokit.paginate(
                  octokit.rest.actions.listRepoVariables,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100,
                  },
                );
                return variables.map((v) => ({ updatedAt: v.updated_at }));
              } catch (error: any) {
                // Repos with Actions disabled, or where the token lacks the
                // `repo`/`actions` scope, reject the variables endpoint with
                // 403/404 — skip them per the per-item not-found rule rather
                // than failing the whole enumeration.
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
      yield* deleteVariable(olds);
    }),
  });

const getVariable = Effect.fn(function* (props: VariableProps) {
  const octokit = yield* octokitFor(props.baseUrl);
  const environment = resolveEnvironmentName(props.environment);
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        if (environment !== undefined) {
          const { data } = await octokit.rest.actions.getEnvironmentVariable({
            owner: props.owner,
            repo: props.repository,
            environment_name: environment,
            name: props.name,
          });
          return data;
        }
        const { data } = await octokit.rest.actions.getRepoVariable({
          owner: props.owner,
          repo: props.repository,
          name: props.name,
        });
        return data;
      } catch (error: any) {
        if (error.status === 404) return undefined;
        throw error;
      }
    },
    catch: (e) => e as Error,
  });
});

const createVariable = Effect.fn(function* (props: VariableProps) {
  const octokit = yield* octokitFor(props.baseUrl);
  const environment = resolveEnvironmentName(props.environment);
  yield* Effect.tryPromise(async () => {
    if (environment !== undefined) {
      await octokit.rest.actions.createEnvironmentVariable({
        owner: props.owner,
        repo: props.repository,
        environment_name: environment,
        name: props.name,
        value: props.value,
      });
    } else {
      await octokit.rest.actions.createRepoVariable({
        owner: props.owner,
        repo: props.repository,
        name: props.name,
        value: props.value,
      });
    }
  });
});

const updateVariable = Effect.fn(function* (props: VariableProps) {
  const octokit = yield* octokitFor(props.baseUrl);
  const environment = resolveEnvironmentName(props.environment);
  yield* Effect.tryPromise(async () => {
    if (environment !== undefined) {
      await octokit.rest.actions.updateEnvironmentVariable({
        owner: props.owner,
        repo: props.repository,
        environment_name: environment,
        name: props.name,
        value: props.value,
      });
    } else {
      await octokit.rest.actions.updateRepoVariable({
        owner: props.owner,
        repo: props.repository,
        name: props.name,
        value: props.value,
      });
    }
  });
});

const deleteVariable = Effect.fn(function* (props: VariableProps) {
  const octokit = yield* octokitFor(props.baseUrl);
  const environment = resolveEnvironmentName(props.environment);
  yield* Effect.tryPromise(async () => {
    try {
      if (environment !== undefined) {
        await octokit.rest.actions.deleteEnvironmentVariable({
          owner: props.owner,
          repo: props.repository,
          environment_name: environment,
          name: props.name,
        });
      } else {
        await octokit.rest.actions.deleteRepoVariable({
          owner: props.owner,
          repo: props.repository,
          name: props.name,
        });
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
    }
  });
});
