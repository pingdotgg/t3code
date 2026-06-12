import type { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitHubCredentials } from "./Credentials.ts";
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
   * Optional environment name. When set the secret is scoped to that
   * GitHub Actions environment instead of the whole repository.
   */
  environment?: string;
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
 *
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

const getOctokit = Effect.gen(function* () {
  const creds = yield* GitHubCredentials;
  return creds.octokit();
});

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
    reconcile: Effect.fn(function* ({ news, olds }) {
      const octokit = yield* getOctokit;

      // Observe — there's no API to read a secret's value back, so we can
      // only observe its location (repo vs. environment, environment name).
      // If the location changed, the previous secret is orphaned: delete
      // it before upserting the new one, otherwise it stays in GitHub as
      // dead state.
      if (olds !== undefined) {
        const wasEnv = !!olds.environment;
        const isEnv = !!news.environment;
        if (wasEnv !== isEnv || olds.environment !== news.environment) {
          yield* deleteSecret(octokit, olds);
        }
      }

      // Ensure & Sync — `createOrUpdate*Secret` is upsert-style: it
      // creates the secret if absent and overwrites it if present. The
      // value is encrypted client-side with the repo/environment public
      // key, so we re-encrypt and re-upload on every reconcile (Redacted
      // values can't be diffed across runs anyway).
      yield* upsertSecret(octokit, news);
      return { updatedAt: new Date().toISOString() };
    }),

    delete: Effect.fn(function* ({ olds }) {
      const octokit = yield* getOctokit;
      yield* deleteSecret(octokit, olds);
    }),
  });

const upsertSecret = Effect.fn(function* (
  octokit: Octokit,
  props: SecretProps,
) {
  const plaintext = Redacted.value(props.value);
  const isEnv = !!props.environment;

  const publicKey = yield* Effect.tryPromise(async () => {
    if (isEnv) {
      const { data } = await octokit.rest.actions.getEnvironmentPublicKey({
        owner: props.owner,
        repo: props.repository,
        environment_name: props.environment!,
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
    if (isEnv) {
      await octokit.rest.actions.createOrUpdateEnvironmentSecret({
        owner: props.owner,
        repo: props.repository,
        environment_name: props.environment!,
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

const deleteSecret = Effect.fn(function* (
  octokit: Octokit,
  props: SecretProps,
) {
  yield* Effect.tryPromise(async () => {
    try {
      if (props.environment) {
        await octokit.rest.actions.deleteEnvironmentSecret({
          owner: props.owner,
          repo: props.repository,
          environment_name: props.environment,
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
