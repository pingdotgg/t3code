import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as HttpClient from "effect/http/HttpClient";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { AlchemyContext } from "../AlchemyContext.ts";
import type { AuthProviders } from "../Auth/AuthProvider.ts";
import type { ProfileStore } from "../Auth/Profile.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";

/** What a secrets provider may depend on. */
export type SecretsServices =
  | Stage
  | Stack
  | AlchemyContext
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | AuthProviders
  | ProfileStore;

/** What a `secrets` callback is given to decide its value. */
export interface SecretsContext {
  readonly stage: string;
  readonly stack: Stack["Service"];
  readonly alchemyContext: AlchemyContext["Service"];
}

/**
 * A value, or a callback that picks it from the {@link SecretsContext}.
 * Both the stack's `secrets` list and every provider's options accept this.
 */
export type SecretsOption<T> = T | ((context: SecretsContext) => T);

/** @internal */
export const resolveSecretsOption = <T>(
  option: SecretsOption<T>,
): Effect.Effect<T, never, Stage | Stack | AlchemyContext> =>
  typeof option !== "function"
    ? Effect.succeed(option)
    : Effect.map(
        Effect.all({
          stage: Stage,
          stack: Stack,
          alchemyContext: AlchemyContext,
        }),
        option as (context: SecretsContext) => T,
      );

/**
 * The process environment, and only that, for a secrets provider's own
 * credentials and platform detection: `DOPPLER_TOKEN`,
 * `INFISICAL_IDENTITY_ID`, `CI`, the OIDC variables. Nothing loaded by an
 * earlier entry can stand in for them, and the stack's precedence is
 * untouched, so a runner's exported variables reach the provider whatever
 * the list says. `ALCHEMY_PROFILE` alone keeps coming from the pinned view
 * the stack built the provider on, so `--profile` still selects the profile.
 *
 * @internal
 */
export const CredentialsConfig = ConfigProvider.layer(
  Effect.map(ConfigProvider.ConfigProvider, (pinned) => {
    const shell = ConfigProvider.fromEnv({ preserveEmptyStrings: true });
    return ConfigProvider.make((path) =>
      (path[0] === "ALCHEMY_PROFILE" ? pinned : shell).load(path),
    );
  }),
);

/** The layer shape every secrets provider builds: it reads the configuration assembled so far and provides the merged one. */
export type SecretsLayer = Layer.Layer<never, unknown, SecretsServices>;

/**
 * What a `secrets` entry must satisfy. Built-in providers are
 * `Data.TaggedClass` instances, so a `_tag` identifies the kind of provider
 * (the stack looks for the process environment this way) and `layer` reads
 * the configuration assembled so far and provides the merged one.
 *
 * ```ts
 * class VaultProvider extends Data.TaggedClass("my-app/SecretProvider::Vault")<{
 *   readonly layer: Secrets.SecretsLayer;
 * }> {}
 * ```
 */
export interface Provider {
  readonly _tag: string;
  readonly layer: SecretsLayer;
}

/** A `secrets` entry: a provider, or any layer that provides a ConfigProvider. */
export type SecretsEntry = Provider | SecretsLayer;
