import fs from "node:fs";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { keySpace as makeKeySpace } from "./cache/shared.ts";

export const VINEXT_KV_CACHE_BINDING = "VINEXT_KV_CACHE";
export const VINEXT_CACHE_BINDING = "VINEXT_CACHE";

const DEFAULT_KV_TTL_SECONDS = 30 * 24 * 3600;

type CacheControlMetadata = {
  revalidate: number;
  expire?: number;
  stale?: number;
};

export type VinextPrerenderKVPair = {
  key: string;
  value: string;
  expirationTtl?: number;
  metadata?: Record<string, unknown>;
};

export const vinextCacheNamespaceFromEnv = (
  env: Record<string, unknown>,
): { namespaceId: string; accountId?: string } | undefined => {
  const raw = env[VINEXT_KV_CACHE_BINDING] ?? env[VINEXT_CACHE_BINDING];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const namespaceId = (raw as { namespaceId?: unknown }).namespaceId;
  const accountId = (raw as { accountId?: unknown }).accountId;
  if (typeof namespaceId !== "string") {
    return undefined;
  }
  return {
    namespaceId,
    accountId: typeof accountId === "string" ? accountId : undefined,
  };
};

/**
 * Walk prerender artifacts with Node fs. vinext's internals are Promise
 * APIs; the walk stays async and reports skip warnings for the Effect
 * caller to log.
 */
export const buildVinextPrerenderKVPairs = async (
  vinextRoot: string,
  serverDir: string,
): Promise<{
  routeCount: number;
  pairs: VinextPrerenderKVPair[];
  warnings: string[];
}> => {
  const importVinextDist = (rel: string) =>
    import(pathToFileURL(nodePath.join(vinextRoot, rel)).href);

  const [
    { readPrerenderManifest, getRenderedAppRoutes, getRenderedMetadataRoutes },
    { appIsrCacheKey },
    { buildAppPageCacheTags, buildAppRouteCacheTags },
    { normalizePregeneratedPathname },
    { getAppRouteOutputPath, getOutputPath, getRscOutputPath },
  ] = await Promise.all([
    importVinextDist("dist/server/prerender-manifest.js"),
    importVinextDist("dist/server/isr-cache.js"),
    importVinextDist("dist/server/app-page-cache.js"),
    importVinextDist("dist/server/pregenerated-concrete-paths.js"),
    importVinextDist("dist/utils/prerender-output-paths.js"),
  ]);

  const manifestPath = nodePath.join(serverDir, "vinext-prerender.json");
  const manifest = readPrerenderManifest(manifestPath);
  if (!manifest?.buildId || !Array.isArray(manifest.routes)) {
    return { routeCount: 0, pairs: [], warnings: [] };
  }

  const prerenderDir = nodePath.join(serverDir, "prerendered-routes");
  if (!fs.existsSync(prerenderDir)) {
    return { routeCount: 0, pairs: [], warnings: [] };
  }

  const pairs: VinextPrerenderKVPair[] = [];
  const warnings: string[] = [];
  const now = Date.now();
  const trailingSlash = manifest.trailingSlash ?? false;
  const keySpace = makeKeySpace(undefined);
  let routeCount = 0;

  for (const route of getRenderedAppRoutes(manifest.routes)) {
    const artifactPathname = route.path ?? route.route;
    const cachePathname = normalizePregeneratedPathname(artifactPathname);
    let htmlPath: string;
    let rscPath: string;
    try {
      htmlPath = resolveContainedFile(
        prerenderDir,
        getOutputPath(artifactPathname, trailingSlash),
      );
      rscPath = resolveContainedFile(
        prerenderDir,
        getRscOutputPath(artifactPathname),
      );
    } catch (error) {
      warnings.push(
        `[vinext] Skipping prerender KV seed for ${artifactPathname}: ${formatUnknownError(error)}`,
      );
      continue;
    }
    if (!fs.existsSync(htmlPath)) continue;

    if (typeof route.revalidate === "number" && route.revalidate <= 0) continue;
    const revalidateSeconds =
      typeof route.revalidate === "number" ? route.revalidate : undefined;
    const expireSeconds =
      typeof route.expire === "number" ? route.expire : undefined;
    const staleSeconds =
      typeof route.stale === "number" && route.stale >= 0
        ? route.stale
        : undefined;
    const expirationTtl =
      revalidateSeconds === undefined ? undefined : DEFAULT_KV_TTL_SECONDS;
    const tags = buildAppPageCacheTags(cachePathname, route.tags ?? []);
    const metadata = buildMetadata(tags);
    const htmlKey = appIsrCacheKey(cachePathname, "html", manifest.buildId);
    const rscKey = appIsrCacheKey(cachePathname, "rsc", manifest.buildId);

    pairs.push({
      key: keySpace.entryKey(htmlKey),
      value: buildCacheEntry(
        {
          kind: "APP_PAGE",
          html: fs.readFileSync(htmlPath, "utf-8"),
          headers: route.headers,
        },
        tags,
        now,
        revalidateSeconds,
        expireSeconds,
        staleSeconds,
      ),
      ...(expirationTtl !== undefined ? { expirationTtl } : {}),
      ...(metadata ? { metadata } : {}),
    });

    if (fs.existsSync(rscPath)) {
      const rscData = fs.readFileSync(rscPath, "base64");
      pairs.push({
        key: keySpace.entryKey(rscKey),
        value: buildCacheEntry(
          {
            kind: "APP_PAGE",
            html: "",
            rscData,
          },
          tags,
          now,
          revalidateSeconds,
          expireSeconds,
          staleSeconds,
        ),
        ...(expirationTtl !== undefined ? { expirationTtl } : {}),
        ...(metadata ? { metadata } : {}),
      });
    }

    routeCount++;
  }

  for (const route of getRenderedMetadataRoutes(manifest.routes)) {
    const pathname = route.path ?? route.route;
    let artifactPath: string;
    try {
      artifactPath = resolveContainedFile(
        prerenderDir,
        getAppRouteOutputPath(pathname),
      );
    } catch (error) {
      warnings.push(
        `[vinext] Skipping metadata prerender KV seed for ${pathname}: ${formatUnknownError(error)}`,
      );
      continue;
    }
    if (!fs.existsSync(artifactPath)) continue;

    const cachePathname = normalizePregeneratedPathname(pathname);
    if (typeof route.revalidate === "number" && route.revalidate <= 0) continue;
    const revalidateSeconds =
      typeof route.revalidate === "number" ? route.revalidate : undefined;
    const expireSeconds =
      typeof route.expire === "number" ? route.expire : undefined;
    const staleSeconds =
      typeof route.stale === "number" && route.stale >= 0
        ? route.stale
        : undefined;
    const expirationTtl =
      revalidateSeconds === undefined ? undefined : DEFAULT_KV_TTL_SECONDS;
    const tags = buildAppRouteCacheTags(
      cachePathname,
      route.tags ?? [],
      route.routeSegments ?? [],
    );
    const metadata = buildMetadata(tags);
    const routeKey = appIsrCacheKey(cachePathname, "route", manifest.buildId);
    pairs.push({
      key: keySpace.entryKey(routeKey),
      value: buildCacheEntry(
        {
          kind: "APP_ROUTE",
          body: fs.readFileSync(artifactPath, "base64"),
          headers: route.headers ?? {},
          status: route.responseStatus ?? 200,
        },
        tags,
        now,
        revalidateSeconds,
        expireSeconds,
        staleSeconds,
      ),
      ...(expirationTtl !== undefined ? { expirationTtl } : {}),
      ...(metadata ? { metadata } : {}),
    });
    routeCount++;
  }

  return { routeCount, pairs, warnings };
};

const resolveContainedFile = (
  rootDir: string,
  relativePath: string,
): string => {
  const resolvedRoot = nodePath.resolve(rootDir);
  const resolvedFile = nodePath.resolve(resolvedRoot, relativePath);
  const relative = nodePath.relative(resolvedRoot, resolvedFile);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    nodePath.isAbsolute(relative)
  ) {
    throw new Error(
      `[vinext] Refusing to read prerender artifact outside ${resolvedRoot}`,
    );
  }
  return resolvedFile;
};

const buildCacheEntry = (
  value: Record<string, unknown>,
  tags: string[],
  now: number,
  revalidateSeconds: number | undefined,
  expireSeconds: number | undefined,
  staleSeconds: number | undefined,
): string => {
  const cacheControl: CacheControlMetadata | undefined =
    revalidateSeconds === undefined
      ? undefined
      : {
          revalidate: revalidateSeconds,
          ...(expireSeconds === undefined ? {} : { expire: expireSeconds }),
          ...(staleSeconds === undefined ? {} : { stale: staleSeconds }),
        };

  return JSON.stringify({
    value,
    tags,
    lastModified: now,
    revalidateAt:
      revalidateSeconds === undefined ? null : now + revalidateSeconds * 1000,
    expireAt: expireSeconds === undefined ? null : now + expireSeconds * 1000,
    ...(cacheControl ? { cacheControl } : {}),
  });
};

const buildMetadata = (tags: string[]): Record<string, unknown> | undefined => {
  const metadata = { tags };
  return JSON.stringify(metadata).length <= 1024 ? metadata : undefined;
};

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
};
