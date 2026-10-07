import { ConfigError } from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ProcessEnv } from "../Secrets/ProcessEnv.ts";
import { resolveSecretsOption } from "../Secrets/Provider.ts";
import type { StackSecrets, StackServices } from "../Stack.ts";

/**
 * Command-line settings that shape a stack's configuration.
 *
 * @internal
 */
export interface StackConfigOverrides {
  /**
   * The `--env-file` flag: the file the CLI reads instead of
   * `.env`. A stack that declares its own `secrets` cannot be combined with
   * it; the list is the single place that decides what loads.
   */
  readonly envFile?: string;
  /** The `--profile` flag. */
  readonly profile?: string;
}

/** @internal */
export const StackConfigOverrides = Context.Reference<StackConfigOverrides>(
  "Alchemy/StackConfigOverrides",
  { defaultValue: () => ({}) },
);

/** Report a secrets provider's own failure as the ConfigError a stack fails with. */
const toConfigError = (error: unknown) =>
  error instanceof ConfigError
    ? error
    : new ConfigError(
        new ConfigProvider.SourceError({
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        }),
      );

/**
 * Build the ConfigProvider a stack runs under from its `secrets` list.
 * When omitted, leave the caller's configuration unchanged.
 *
 * Each provider is a layer that requires the configuration assembled so far
 * and provides the merged result, so the list folds with `Layer.provide`:
 * later providers override earlier ones. With an explicit list, `ALCHEMY_PROFILE` is taken
 * from `--profile` or the real process environment only, never from a
 * provider, so a dotenv file or a secrets manager cannot redirect which
 * credentials every other provider uses.
 *
 * @internal
 */
export const stackConfigLayer = (
  secrets?: StackSecrets,
): Layer.Layer<never, ConfigError, StackServices> =>
  secrets === undefined
    ? Layer.empty
    : Layer.effect(
        ConfigProvider.ConfigProvider,
        Effect.gen(function* () {
          const overrides = yield* StackConfigOverrides;
          if (overrides.envFile !== undefined) {
            return yield* Effect.fail(
              new ConfigError(
                new ConfigProvider.SourceError({
                  message: `--env-file cannot be combined with a stack that declares \`secrets\`. Add Secrets.DotEnv({ path: "${overrides.envFile}" }) to the list instead, or drop the flag.`,
                }),
              ),
            );
          }

          const declared = yield* resolveSecretsOption(secrets);

          // Every list ends with the shell unless the user placed (or disabled) it.
          const entries = Array.isArray(declared) ? [...declared] : [declared];
          const shellListed = entries.some(
            (entry) =>
              "_tag" in entry &&
              entry._tag === "alchemy/SecretProvider::ProcessEnv",
          );
          if (!shellListed) entries.push(ProcessEnv());

          // `ALCHEMY_PROFILE` is answered from `--profile` or the real shell,
          // never from a provider. Every provider is built on a pinned view (so
          // its credentials resolve against the right profile) and the stack
          // gets a pinned view of the final result.
          const profile =
            overrides.profile ??
            (yield* Effect.sync(
              () => process.env.ALCHEMY_PROFILE || undefined,
            ));
          const pinned = ConfigProvider.fromEnv({
            env: profile === undefined ? {} : { ALCHEMY_PROFILE: profile },
          });
          const pin = (provider: ConfigProvider.ConfigProvider) =>
            ConfigProvider.make((path) =>
              (path[0] === "ALCHEMY_PROFILE" ? pinned : provider).load(path),
            );

          const chain = entries.reduce<
            Layer.Layer<never, unknown, StackServices>
          >(
            (below, entry) =>
              ("layer" in entry ? entry.layer : entry).pipe(
                // A reused entry must merge with this position's configuration,
                // not return the result memoized at its first position.
                Layer.fresh,
                Layer.provide(
                  ConfigProvider.layer(
                    Effect.map(ConfigProvider.ConfigProvider, pin),
                  ).pipe(Layer.provide(below)),
                ),
              ),
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          );
          const context = yield* Layer.build(chain).pipe(
            Effect.mapError(toConfigError),
          );
          return pin(Context.get(context, ConfigProvider.ConfigProvider));
        }),
      );

/**
 * The ConfigProvider a CLI command runs under before any stack is loaded:
 * an explicit `--env-file` overrides the process environment. Without that
 * flag, the process environment overrides an optional `.env` file.
 */
export const loadConfigProvider = Effect.fn("loadConfigProvider")(function* (
  envFile: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem;

  let path: string | undefined;
  if (Option.isSome(envFile)) {
    path = envFile.value;
  } else if (yield* fs.exists(".env")) {
    path = ".env";
  }

  // `fromEnv` snapshots `process.env` when called, so build it here rather
  // than once at module load.
  const shell = ConfigProvider.fromEnv();
  if (path === undefined) return shell;
  const dotEnv = yield* ConfigProvider.fromDotEnv({
    path,
  });
  return Option.isSome(envFile)
    ? ConfigProvider.orElse(dotEnv, shell)
    : ConfigProvider.orElse(shell, dotEnv);
});
