import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

/**
 * The variable names an env-style ConfigProvider knows, for debug logging.
 *
 * `fromEnv`/`fromDotEnv` index variables as a trie split on `_`
 * (`APP_DB_URL` lives at `["APP", "DB", "URL"]`), so the names are rebuilt
 * by walking that trie and joining the segments again. A node carrying a
 * value is a variable even when it also has children (`APP` and `APP_DB`).
 * Values are never read.
 */
export const envKeys = (provider: ConfigProvider.ConfigProvider) => {
  const walk = (
    path: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, ConfigProvider.SourceError> =>
    Effect.gen(function* () {
      const node = yield* provider.load(path);
      if (node === undefined) return [];
      const name = path.join("_");
      if (node._tag === "Value") return [name];
      if (node._tag !== "Record") return [];
      const children = yield* Effect.forEach([...node.keys], (key) =>
        walk([...path, key]),
      );
      const own = node.value === undefined ? [] : [name];
      return [...own, ...children.flat()];
    });
  return walk([]).pipe(Effect.catch(() => Effect.succeed([])));
};

/** `Loaded 3 secrets from <source>: A, B, C` at debug level. Names are sorted. */
export const logLoadedKeys = (source: string, keys: ReadonlyArray<string>) =>
  Effect.logDebug(
    keys.length === 0
      ? `Loaded no secrets from ${source}`
      : `Loaded ${keys.length} secrets from ${source}: ${[...keys].sort().join(", ")}`,
  );
