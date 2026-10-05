import { downloadSecret, fromApiKey } from "@distilled.cloud/doppler";
import * as Retry from "@distilled.cloud/doppler/Retry";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { AuthError, refreshHint } from "../Auth/AuthProvider.ts";
import { SuppressMissingProviderConfig } from "../Auth/Profile.ts";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  DopplerAuth,
  type DopplerAuthConfig,
  type DopplerResolvedCredentials,
} from "./AuthProvider.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { logLoadedKeys } from "../Secrets/Log.ts";
import {
  CredentialsConfig,
  resolveSecretsOption,
  type SecretsLayer,
  type SecretsOption,
} from "../Secrets/Provider.ts";

export interface DopplerOptions {
  /** Project slug. Required with browser login or personal tokens. */
  project?: string;
  /** Config slug, e.g. `dev` or `prd`. Required with browser login or personal tokens. */
  config?: string;
}

interface DopplerCredentials {
  readonly token: Redacted.Redacted<string>;
  /** Set when the token came from a stored Alchemy profile. */
  readonly profileName?: string;
  /** How the stored profile authenticated, when the token came from one. */
  readonly method?: DopplerAuthConfig["method"];
}

/** Human description of which secrets were asked for, for error messages. */
const describeSelection = (options: DopplerOptions) => {
  if (options.project && options.config) {
    return `project '${options.project}' config '${options.config}'`;
  }
  if (options.project) {
    return `project '${options.project}'`;
  }
  return "the token's own project and config";
};

/**
 * Doppler could not serve the requested secrets. The message says "Doppler"
 * up front and names the selection, so a stack trace never has to be read
 * to know which secrets source broke.
 */
export class DopplerSecretsError extends Data.TaggedError(
  "DopplerSecretsError",
)<{
  readonly selection: DopplerOptions;
  readonly credentials: DopplerCredentials;
  /** What the Doppler SDK failed with. */
  readonly cause: { readonly _tag: string; readonly message: string };
}> {
  readonly [UserFacingError] = true;

  override get message() {
    const selection = describeSelection(this.selection);
    switch (this.cause._tag) {
      case "Unauthorized":
        return this.credentials.profileName === undefined
          ? "Doppler rejected the token. Check DOPPLER_TOKEN; to log in locally run `alchemy profile edit --add Doppler`."
          : `Doppler credentials were rejected. ${refreshHint("Doppler", this.credentials.profileName)}`;
      case "NotFound":
        return `Doppler could not find ${selection}: ${this.cause.message}. Check Doppler.Secrets({ project, config }) and that the token has access to it.`;
      default:
        return `Doppler could not download secrets for ${selection}: ${this.cause.message}`;
    }
  }
}

/**
 * Resolve the token through the Doppler auth provider: `DOPPLER_TOKEN` when
 * present, otherwise the selected profile.
 */
const resolveCredentials = Effect.gen(function* () {
  const resolved = yield* resolveProviderConfig<
    DopplerAuthConfig,
    DopplerResolvedCredentials
  >("Doppler").pipe(Effect.provide(DopplerAuth));
  const { token } = yield* resolved.resolve;
  const credentials: DopplerCredentials = {
    token,
    profileName: resolved.profileName,
    method: resolved.config?.method,
  };
  return credentials;
}).pipe(Effect.provide(CredentialsConfig));

/** Download every secret of the selected project/config as a flat env map. */
const downloadSecrets = Effect.fn("downloadDopplerSecrets")(function* (
  options: DopplerOptions,
  credentials: DopplerCredentials,
) {
  const secrets = yield* downloadSecret({
    project: options.project,
    config: options.config,
    format: "json",
  }).pipe(
    Retry.none,
    Effect.provide(fromApiKey({ apiKey: credentials.token })),
    Effect.timeout("30 seconds"),
    Effect.mapError(
      (cause) =>
        new DopplerSecretsError({ selection: options, credentials, cause }),
    ),
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
});

/** A `secrets` entry that loads a Doppler config. */
export class DopplerSecretsProvider extends Data.TaggedClass(
  "alchemy/SecretProvider::Doppler",
)<{ readonly layer: SecretsLayer }> {}

/**
 * Load Doppler secrets into Effect Config without touching `process.env`.
 * Config-scoped service tokens may omit `project` and `config`.
 *
 * Authenticate locally with `alchemy profile edit --add Doppler` and choose
 * Login or API token. In CI, set `DOPPLER_TOKEN`, or `DOPPLER_IDENTITY_ID`
 * to log in with the platform's OIDC token. Loading secrets never starts a
 * login flow.
 *
 * ```ts
 * secrets: [
 *   Doppler.Secrets(({ stage }) => ({
 *     project: "my-app",
 *     config: stage === "prod" ? "prd" : "dev",
 *   })),
 * ]
 * ```
 */
export const Secrets = (options: SecretsOption<DopplerOptions> = {}) =>
  new DopplerSecretsProvider({
    layer: ConfigProvider.layerAdd(
      Effect.gen(function* () {
        // Auth-provider discovery builds stack layers just to find out which
        // providers are used. It must work offline and with expired tokens, so
        // the user can configure or refresh the very token this layer needs.
        if (yield* SuppressMissingProviderConfig)
          return ConfigProvider.fromEnv({ env: {} });

        const resolved = yield* resolveSecretsOption(options);
        const credentials = yield* resolveCredentials;

        // Browser-login tokens are personal tokens: they can see every project,
        // so Doppler needs to be told which one to read.
        const missingSelector = !resolved.project || !resolved.config;
        if (credentials.method === "login" && missingSelector) {
          return yield* new AuthError({
            message:
              "Doppler browser login requires both project and config in Doppler.Secrets({ project, config }).",
          });
        }

        const env = yield* downloadSecrets(resolved, credentials);
        yield* logLoadedKeys(
          `Doppler (${describeSelection(resolved)})`,
          Object.keys(env),
        );
        return ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
      }),
      { asPrimary: true },
    ),
  });
