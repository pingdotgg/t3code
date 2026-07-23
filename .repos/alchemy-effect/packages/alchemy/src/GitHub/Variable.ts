import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitHubCredentials } from "./Credentials.ts";
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
 *
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

const getOctokit = Effect.gen(function* () {
  const creds = yield* GitHubCredentials;
  return creds.octokit();
});

export const VariableProvider = () =>
  Provider.succeed(Variable, {
    reconcile: Effect.fn(function* ({ news }) {
      const octokit = yield* getOctokit;

      // Observe — `name` is the path identifier for repo variables; ask
      // GitHub directly for the live row. A 404 means it doesn't exist
      // (deleted out-of-band, or never created), so we converge by
      // creating it; otherwise we PATCH the value.
      const observed = yield* Effect.tryPromise({
        try: async () => {
          try {
            const { data } = await octokit.rest.actions.getRepoVariable({
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

      // Ensure — POST creates the variable.
      if (observed === undefined) {
        yield* Effect.tryPromise(() =>
          octokit.rest.actions.createRepoVariable({
            owner: news.owner,
            repo: news.repository,
            name: news.name,
            value: news.value,
          }),
        );
        return { updatedAt: new Date().toISOString() };
      }

      // Sync — PATCH the value if it drifted; skip the call when the
      // observed value already matches to keep the API quiet.
      if (observed.value !== news.value) {
        yield* Effect.tryPromise(() =>
          octokit.rest.actions.updateRepoVariable({
            owner: news.owner,
            repo: news.repository,
            name: news.name,
            value: news.value,
          }),
        );
      }
      return { updatedAt: new Date().toISOString() };
    }),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* getOctokit;

      yield* Effect.tryPromise(async () => {
        try {
          await octokit.rest.actions.deleteRepoVariable({
            owner: olds.owner,
            repo: olds.repository,
            name: olds.name,
          });
        } catch (error: any) {
          if (error.status !== 404) {
            throw error;
          }
        }
      });
    }),
  });
