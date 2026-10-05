/**
 * Seed a persistent vinext data-cache store from `dist/server` prerender
 * artifacts.
 *
 * One write path for every platform: load pairs, then `sink.putText`.
 *
 * - Cloudflare: `Website.Vinext` build calls {@link seedPrerenderTo} with
 *   {@link kvHttpSink} (distilled KV HTTP, deploy machine).
 * - Node / Lambda: the Redis / S3 runtime calls
 *   {@link seedStoreFromPrerenderLogged} on first cache op (artifacts
 *   ship in the image).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodePath from "node:path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import {
  buildVinextPrerenderKVPairs,
  type VinextPrerenderKVPair,
} from "../PrerenderCache.ts";
import type { DataCacheStore } from "./handler.ts";

export interface SeedSink<E = never, R = never> {
  readonly putText: (
    key: string,
    value: string,
    ttlMs?: number,
  ) => Effect.Effect<unknown, E, R>;
}

export type LoadedPrerenderPairs = {
  readonly pairs: ReadonlyArray<VinextPrerenderKVPair>;
  readonly routeCount: number;
  readonly warnings: ReadonlyArray<string>;
};

const resolveVinextRoot = (cwd: string): string | undefined => {
  const projectRequire = createRequire(nodePath.join(cwd, "package.json"));
  // vinext does not export package.json; use Node's package search directories.
  for (const directory of projectRequire.resolve.paths("vinext") ?? []) {
    const root = nodePath.join(directory, "vinext");
    if (existsSync(nodePath.join(root, "package.json"))) return root;
  }
  return undefined;
};

const resolveServerDir = (cwd: string): string | undefined => {
  const fromEnv = process.env.VINEXT_SERVER_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const candidates = [
    nodePath.join(cwd, "dist", "server"),
    nodePath.join(cwd, "server"),
    cwd,
  ];
  for (const dir of candidates) {
    if (existsSync(nodePath.join(dir, "vinext-prerender.json"))) return dir;
  }
  return undefined;
};

const ttlMsOf = (pair: VinextPrerenderKVPair): number | undefined =>
  pair.expirationTtl !== undefined && pair.expirationTtl > 0
    ? pair.expirationTtl * 1000
    : undefined;

export const loadPrerenderPairs = async (
  cwd: string,
): Promise<LoadedPrerenderPairs> => {
  const vinextRoot = resolveVinextRoot(cwd);
  const serverDir = resolveServerDir(cwd);
  if (vinextRoot === undefined || serverDir === undefined) {
    return { pairs: [], routeCount: 0, warnings: [] };
  }
  return buildVinextPrerenderKVPairs(vinextRoot, serverDir);
};

/** Platform-agnostic seed: pairs → `sink.putText`. */
export const seedPrerenderTo = <E, R>(
  sink: SeedSink<E, R>,
  options: { readonly rootDir: string; readonly label: string },
): Effect.Effect<
  { readonly count: number; readonly routeCount: number },
  E,
  R
> =>
  Effect.gen(function* () {
    const loaded = yield* Effect.promise(() =>
      loadPrerenderPairs(options.rootDir),
    );
    for (const warning of loaded.warnings) yield* Console.warn(warning);
    if (loaded.pairs.length === 0) {
      return { count: 0, routeCount: loaded.routeCount };
    }
    yield* Effect.forEach(
      loaded.pairs,
      (pair) => sink.putText(pair.key, pair.value, ttlMsOf(pair)),
      { concurrency: 8 },
    );
    yield* Console.log(
      `[vinext] seeded ${loaded.pairs.length} prerender cache ${
        loaded.pairs.length === 1 ? "entry" : "entries"
      } into ${options.label} (${loaded.routeCount} route${
        loaded.routeCount === 1 ? "" : "s"
      })`,
    );
    return { count: loaded.pairs.length, routeCount: loaded.routeCount };
  });

const promiseSink = (store: DataCacheStore): SeedSink => ({
  putText: (key, value, ttlMs) =>
    Effect.promise(() => store.getText(key)).pipe(
      Effect.flatMap((existing) =>
        existing === undefined
          ? Effect.promise(() => store.putText(key, value, ttlMs))
          : Effect.void,
      ),
    ),
});

export const seedStoreFromPrerender = async (
  store: DataCacheStore,
  cwd = process.cwd(),
): Promise<number> => {
  const { count } = await Effect.runPromise(
    seedPrerenderTo(promiseSink(store), { rootDir: cwd, label: "store" }),
  );
  return count;
};

/** Await seed and log how many entries landed. Never throws. */
export const seedStoreFromPrerenderLogged = async (
  store: DataCacheStore,
  label: string,
  cwd = process.cwd(),
): Promise<number> => {
  try {
    const { count } = await Effect.runPromise(
      seedPrerenderTo(promiseSink(store), { rootDir: cwd, label }),
    );
    return count;
  } catch {
    return 0;
  }
};

export const _resolveForTests = { resolveVinextRoot, resolveServerDir };
