import { fromApiKey, getProjectBySlug, listSecretsV4 } from "@distilled.cloud/infisical";
import * as Retry from "@distilled.cloud/infisical/Retry";
import { refreshHint } from "alchemy/Auth/AuthProvider";
import { SuppressMissingProviderConfig } from "alchemy/Auth/Profile";
import { resolveProviderConfig } from "alchemy/Auth/Resolve";
import { logLoadedKeys } from "alchemy/Secrets/Log";
import {
  CredentialsConfig,
  resolveSecretsOption,
  type SecretsLayer,
  type SecretsOption,
} from "alchemy/Secrets/Provider";
import { UserFacingError } from "alchemy/UserFacingError";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  InfisicalAuth,
  type InfisicalAuthConfig,
  type InfisicalResolvedCredentials,
} from "./AuthProvider.ts";

export interface InfisicalOptions {
  /**
   * Project slug, or the project's UUID. Infisical only resolves slugs for
   * machine identities, so a user token must pass the UUID.
   */
  project: string;
  /** Environment slug, e.g. `dev` or `prod`. */
  environment: string;
  /**
   * Folder to read from.
   * @default "/"
   */
  path?: string;
  /**
   * Also read every sub-folder of `path`.
   * @default false
   */
  recursive?: boolean;
  /**
   * Include secrets imported into the folder from elsewhere. Directly
   * defined secrets win over imported ones.
   * @default true
   */
  includeImports?: boolean;
}

interface InfisicalCredentials extends InfisicalResolvedCredentials {
  /** Set when the credentials came from a stored Alchemy profile. */
  readonly profileName?: string;
}

/** Human description of which secrets were asked for, for error messages. */
const describeSelection = (options: InfisicalOptions) => {
  const folder = options.path === undefined ? "" : ` path '${options.path}'`;
  return `project '${options.project}' environment '${options.environment}'${folder}`;
};

/**
 * Infisical could not serve the requested secrets. The message says
 * "Infisical" up front and names the selection, so a stack trace never has
 * to be read to know which secrets source broke.
 */
export class InfisicalSecretsError extends Data.TaggedError("InfisicalSecretsError")<{
  readonly selection: InfisicalOptions;
  readonly credentials: InfisicalCredentials;
  /** What the Infisical SDK failed with. */
  readonly cause: { readonly _tag: string; readonly message: string };
}> {
  readonly [UserFacingError] = true;

  override get message() {
    const selection = describeSelection(this.selection);
    switch (this.cause._tag) {
      case "Unauthorized":
        return this.credentials.profileName === undefined
          ? "Infisical rejected the token. Check INFISICAL_TOKEN; to set up a machine identity locally run `alchemy profile edit --add Infisical`."
          : `Infisical credentials were rejected. ${refreshHint("Infisical", this.credentials.profileName)}`;
      case "NotFound":
      case "Forbidden":
        return `Infisical could not read ${selection}: ${this.cause.message}. Check Infisical.Secrets({ project, environment }) and that the identity has read access to it.`;
      default:
        return `Infisical could not download secrets for ${selection}: ${this.cause.message}`;
    }
  }
}

/**
 * Resolve credentials through the Infisical auth provider: `INFISICAL_TOKEN`
 * when present, otherwise the selected profile (which mints a token from
 * the stored machine identity).
 */
const resolveCredentials = Effect.gen(function* () {
  const resolved = yield* resolveProviderConfig<InfisicalAuthConfig, InfisicalResolvedCredentials>(
    "Infisical",
  ).pipe(Effect.provide(InfisicalAuth));
  const { token, apiBaseUrl } = yield* resolved.resolve;
  const credentials: InfisicalCredentials = {
    token,
    apiBaseUrl,
    profileName: resolved.profileName,
  };
  return credentials;
}).pipe(Effect.provide(CredentialsConfig));

const isUUID = Schema.is(Schema.String.check(Schema.isUUID()));

const text = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Download the selected secrets (plus imports) as a flat env map. */
const downloadSecrets = Effect.fn("downloadInfisicalSecrets")(function* (
  options: InfisicalOptions,
  credentials: InfisicalCredentials,
) {
  const includeImports = options.includeImports ?? true;
  const response = yield* Effect.gen(function* () {
    // The v4 secrets API only accepts project ids, so resolve slugs first.
    const projectId = isUUID(options.project)
      ? options.project
      : (yield* getProjectBySlug({ slug: options.project })).id;
    return yield* listSecretsV4({
      projectId,
      environment: options.environment,
      secretPath: options.path,
      recursive: options.recursive,
      includeImports,
      viewSecretValue: true,
      expandSecretReferences: true,
    });
  }).pipe(
    Retry.none,
    Effect.provide(
      fromApiKey({
        apiKey: credentials.token,
        apiBaseUrl: credentials.apiBaseUrl,
      }),
    ),
    Effect.timeout("30 seconds"),
    Effect.mapError(
      (cause) => new InfisicalSecretsError({ selection: options, credentials, cause }),
    ),
  );

  // Imports first so a directly defined secret overwrites an imported one.
  const env: Record<string, string> = {};
  for (const imported of response.imports ?? []) {
    for (const secret of imported.secrets) {
      env[text(secret.secretKey)] = secret.secretValue;
    }
  }
  for (const secret of response.secrets) {
    env[text(secret.secretKey)] = secret.secretValue;
  }
  return env;
});

/** A `secrets` entry that loads an Infisical environment. */
export class InfisicalSecretsProvider extends Data.TaggedClass(
  "alchemy/SecretProvider::Infisical",
)<{ readonly layer: SecretsLayer }> {}

/**
 * Load Infisical secrets into Effect Config without touching `process.env`.
 *
 * Authenticate locally with `alchemy profile edit --add Infisical` and
 * paste a machine identity's universal-auth client id and secret; Alchemy
 * mints a fresh access token on every run. The client secret must remain valid. In
 * CI, set `INFISICAL_TOKEN`, or `INFISICAL_IDENTITY_ID` to log in with the
 * platform's OIDC token.
 *
 * ```ts
 * secrets: [
 *   Infisical.Secrets(({ stage }) => ({
 *     project: "my-app",
 *     environment: stage === "prod" ? "prod" : "dev",
 *   })),
 * ]
 * ```
 */
export const Secrets = (options: SecretsOption<InfisicalOptions>) =>
  new InfisicalSecretsProvider({
    layer: ConfigProvider.layerAdd(
      Effect.gen(function* () {
        // Auth-provider discovery builds stack layers just to find out which
        // providers are used. It must work offline and with broken
        // credentials, so the user can configure the very identity this
        // layer needs.
        if (yield* SuppressMissingProviderConfig) return ConfigProvider.fromEnv({ env: {} });

        const resolved = yield* resolveSecretsOption(options);
        const credentials = yield* resolveCredentials;
        const env = yield* downloadSecrets(resolved, credentials);
        yield* logLoadedKeys(`Infisical (${describeSelection(resolved)})`, Object.keys(env));
        return ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
      }),
      { asPrimary: true },
    ),
  });
