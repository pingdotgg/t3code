import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { type Environment, resolveEnvironmentName } from "./Environment.ts";
import { gitHubBaseUrlChanged, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface SecretProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Secret name (e.g. `AWS_ROLE_ARN`).
   */
  name: string;

  /**
   * Secret value. Wrap with `Redacted.make` to prevent the value from
   * appearing in logs or state.
   */
  value: Redacted.Redacted;

  /**
   * Optional environment. When set the secret is scoped to that GitHub
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

export interface Secret extends Resource<
  "GitHub.Secret",
  SecretProps,
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
 * A GitHub Actions repository or environment secret.
 *
 * `Secret` manages the lifecycle of an encrypted secret in GitHub Actions.
 * Secrets are encrypted using the repository's (or environment's) public
 * key via `libsodium` before being stored. The resource is idempotent —
 * calling it with the same name will update the secret value in place.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied
 * by `GitHub.providers()` (which uses the Alchemy AuthProvider — env,
 * stored PAT, `gh` CLI, or OAuth). The token needs `repo` scope for
 * private repositories or `public_repo` for public ones.
 * @resource
 * @section Repository Secrets
 * Store secrets accessible to all GitHub Actions workflows in the
 * repository.
 *
 * @example Create a Repository Secret
 * ```typescript
 * yield* GitHub.Secret("aws-role", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_ROLE_ARN",
 *   value: Redacted.make(role.roleArn),
 * });
 * ```
 *
 * @section Environment Secrets
 * Scope a secret to a specific GitHub Actions environment (e.g.
 * `production`, `staging`). Environment secrets require environment
 * protection rules to be satisfied before workflows can access them.
 *
 * @example Create an Environment Secret
 * ```typescript
 * yield* GitHub.Secret("deploy-key", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: "production",
 *   name: "DEPLOY_KEY",
 *   value: Redacted.make("my-secret-value"),
 * });
 * ```
 *
 * @section Wiring with Other Resources
 * A common pattern is wiring the output of another resource — like an
 * IAM role ARN or a database URL — directly into a GitHub secret so
 * that CI workflows can use it.
 *
 * @example Store an IAM Role ARN for CI
 * ```typescript
 * const role = yield* AWS.IAM.Role("ci-role", { ... });
 *
 * yield* GitHub.Secret("ci-role-arn", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   name: "AWS_ROLE_ARN",
 *   value: Redacted.make(role.roleArn),
 * });
 * ```
 *
 * @example Store Multiple Secrets
 * ```typescript
 * yield* GitHub.Secret("db-url", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: "production",
 *   name: "DATABASE_URL",
 *   value: Redacted.make(database.connectionString),
 * });
 *
 * yield* GitHub.Secret("api-key", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   environment: "production",
 *   name: "API_KEY",
 *   value: Redacted.make(apiKey),
 * });
 * ```
 */
export const Secret = Resource<Secret>("GitHub.Secret");

async function encryptValue(
  plaintext: string,
  publicKey: string,
): Promise<string> {
  const mod = await import("libsodium-wrappers");
  // Bun/ESM interop: the actual sodium API lives on `.default` when the
  // CJS module is wrapped, but is the module itself under other loaders.
  const sodium: typeof import("libsodium-wrappers") =
    (mod as any).default ?? mod;
  await sodium.ready;
  const binKey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const binMessage = sodium.from_string(plaintext);
  const encrypted = sodium.crypto_box_seal(binMessage, binKey);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    // A secret's entire identity is (host, owner, repository, environment,
    // name) — GitHub has no rename/move API for secrets, so changing any of
    // them replaces the resource: the engine upserts the new secret first,
    // then `delete` removes the old one from its old location. Replacement
    // is safe here — a secret is declarative config that is fully
    // re-creatable from props.
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

    // Non-listable: a GitHub Actions secret is keyed entirely by its parent
    // (owner, repository[, environment], name) which arrive as props — there is
    // no ambient owner/repo scope to enumerate from, `list()` takes no input,
    // and the `Attributes` shape carries no identifying keys (only `updatedAt`).
    // GitHub only exposes list-secrets *within* a specific repo/environment, so
    // there is no account-wide enumeration API. Return an empty array.
    list: () => Effect.succeed([]),

    reconcile: Effect.fn(function* ({ news, olds }) {
      // Observe — there's no API to read a secret's value back, so we can
      // only observe its location (repo vs. environment, environment name).
      // A location change normally arrives as a replacement (see `diff`);
      // this guard is the safety net for the plan-time path where `news`
      // contained unresolved outputs and diff could not compare — delete the
      // orphaned secret from its old location before upserting the new one.
      if (
        olds !== undefined &&
        resolveEnvironmentName(olds.environment) !==
          resolveEnvironmentName(news.environment)
      ) {
        yield* deleteSecret(olds);
      }

      // Ensure & Sync — `createOrUpdate*Secret` is upsert-style: it
      // creates the secret if absent and overwrites it if present. The
      // value is encrypted client-side with the repo/environment public
      // key, so we re-encrypt and re-upload on every reconcile (Redacted
      // values can't be diffed across runs anyway).
      yield* upsertSecret(news);
      return { updatedAt: new Date().toISOString() };
    }),

    delete: Effect.fn(function* ({ olds }) {
      yield* deleteSecret(olds);
    }),
  });

const upsertSecret = Effect.fn(function* (props: SecretProps) {
  const octokit = yield* octokitFor(props.baseUrl);
  const plaintext = Redacted.value(props.value);
  const environment = resolveEnvironmentName(props.environment);

  const publicKey = yield* Effect.tryPromise(async () => {
    if (environment !== undefined) {
      const { data } = await octokit.rest.actions.getEnvironmentPublicKey({
        owner: props.owner,
        repo: props.repository,
        environment_name: environment,
      });
      return data;
    }
    const { data } = await octokit.rest.actions.getRepoPublicKey({
      owner: props.owner,
      repo: props.repository,
    });
    return data;
  });

  const encrypted = yield* Effect.tryPromise(() =>
    encryptValue(plaintext, publicKey.key),
  );

  yield* Effect.tryPromise(async () => {
    if (environment !== undefined) {
      await octokit.rest.actions.createOrUpdateEnvironmentSecret({
        owner: props.owner,
        repo: props.repository,
        environment_name: environment,
        secret_name: props.name,
        encrypted_value: encrypted,
        key_id: publicKey.key_id,
      });
    } else {
      await octokit.rest.actions.createOrUpdateRepoSecret({
        owner: props.owner,
        repo: props.repository,
        secret_name: props.name,
        encrypted_value: encrypted,
        key_id: publicKey.key_id,
      });
    }
  });
});

const deleteSecret = Effect.fn(function* (props: SecretProps) {
  const octokit = yield* octokitFor(props.baseUrl);
  const environment = resolveEnvironmentName(props.environment);
  yield* Effect.tryPromise(async () => {
    try {
      if (environment !== undefined) {
        await octokit.rest.actions.deleteEnvironmentSecret({
          owner: props.owner,
          repo: props.repository,
          environment_name: environment,
          secret_name: props.name,
        });
      } else {
        await octokit.rest.actions.deleteRepoSecret({
          owner: props.owner,
          repo: props.repository,
          secret_name: props.name,
        });
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
    }
  });
});
