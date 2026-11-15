// @effect-diagnostics nodeBuiltinImport:off - A synchronous hash keeps these layout rules pure.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";

/** Reserved folder inside a worktree location that holds checkout caches on that location's drive. */
export const CHECKOUT_CACHE_FOLDER = ".t3-checkout-cache";

/** Names one T3 state dir's cache, so homes that share a worktree location never touch each other's. */
export const homeKey = (realStateDir: string): string =>
  NodeCrypto.createHash("sha256").update(realStateDir).digest("hex").slice(0, 16);

/** The home that owns a folder in a reserved folder: its cache, or trash a discard left of it. */
export const ownerOfCacheFolder = (name: string): string | undefined =>
  /^([0-9a-f]{16})(?:\.trash-.+)?$/.exec(name)?.[1];

export const inRootCacheDir = (root: string, key: string, path: Path.Path): string =>
  path.join(root, CHECKOUT_CACHE_FOLDER, key);

/**
 * True inside any checkout cache: below a `.t3-checkout-cache` folder, or in this T3 home's own
 * cache folder or the trash and probe folders beside it. Caches are never written behind a link.
 */
export const isCheckoutCachePath = (
  candidate: string,
  options: { readonly homeCacheDir: string; readonly caseFold?: boolean },
): boolean => {
  const normalize = (value: string) => {
    const slashed = value.replaceAll("\\", "/").replace(/\/+$/, "");
    return options.caseFold === true ? slashed.toLowerCase() : slashed;
  };
  const target = `${normalize(candidate)}/`;
  const home = normalize(options.homeCacheDir);
  return (
    target.includes(`/${CHECKOUT_CACHE_FOLDER}/`) ||
    [`${home}/`, `${home}.trash-`, `${home}.probe-`].some((prefix) => target.startsWith(prefix))
  );
};

/** The T3 home's cache folder below the real path of its `caches` folder, which exists from boot. */
export const homeCheckoutCacheDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreeCheckoutCacheDir } = yield* ServerConfig.ServerConfig;
  const caches = path.dirname(worktreeCheckoutCacheDir);
  const real = yield* fileSystem.realPath(caches).pipe(Effect.orElseSucceed(() => caches));
  return path.join(real, path.basename(worktreeCheckoutCacheDir));
});
