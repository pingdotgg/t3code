import { ConfigError } from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import { envKeys, logLoadedKeys } from "./Log.ts";
import {
  resolveSecretsOption,
  type SecretsLayer,
  type SecretsOption,
} from "./Provider.ts";

export interface DotEnvOptions {
  /**
   * File or ordered files to load. Later files override earlier files.
   * Every explicitly supplied path must exist; an empty array loads no files.
   * @default ".env"
   */
  path?: string | readonly string[];
  /**
   * Expand `${VAR}` references within the file.
   * @default false
   */
  expandVariables?: boolean;
}

/** A `secrets` entry that loads dotenv files. */
export class DotEnvProvider extends Data.TaggedClass(
  "alchemy/SecretProvider::DotEnv",
)<{ readonly layer: SecretsLayer }> {}

/**
 * Add dotenv files to Effect's ConfigProvider without touching `process.env`.
 *
 * Keys missing from every file fall back to the previous provider; an empty
 * value in a file is a real value and overrides it. With no explicit `path`,
 * a missing `.env` is silently ignored.
 *
 * Options may be a callback so a stack can pick files by stage:
 *
 * ```ts
 * secrets: [Secrets.DotEnv(({ stage }) => ({ path: [".env", `.env.${stage}`] }))]
 * ```
 */
export const DotEnv = (options: SecretsOption<DotEnvOptions> = {}) =>
  new DotEnvProvider({
    layer: ConfigProvider.layerAdd(
      Effect.gen(function* () {
        const resolved = yield* resolveSecretsOption(options);
        const fs = yield* FileSystem;

        // The implicit default `.env` may be absent; a file named
        // explicitly must exist.
        const explicit = resolved.path !== undefined;
        const path = resolved.path ?? ".env";
        const paths = typeof path === "string" ? [path] : path;

        let loaded = ConfigProvider.fromEnv({ env: {} });
        for (const path of paths) {
          const file = yield* Effect.gen(function* () {
            if (!explicit && !(yield* fs.exists(path))) return undefined;
            return yield* ConfigProvider.fromDotEnv({
              path,
              expandVariables: resolved.expandVariables,
              preserveEmptyStrings: true,
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ConfigError(
                  new ConfigProvider.SourceError({
                    message: `Failed to read dotenv file ${path}`,
                    cause,
                  }),
                ),
            ),
          );
          if (file !== undefined) loaded = ConfigProvider.orElse(file, loaded);
        }
        yield* logLoadedKeys(
          `dotenv (${paths.join(", ") || "no files"})`,
          yield* envKeys(loaded),
        );
        return loaded;
      }),
      { asPrimary: true },
    ),
  });
