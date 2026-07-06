import {
  PLUGIN_ID_PATTERN_SOURCE,
  type PluginId,
  type PluginLockfile,
} from "@t3tools/contracts/plugin";
import {
  getPluginHostShimSource,
  pluginHostModuleFromPath,
  PLUGIN_WEB_BUNDLE_CACHE_CONTROL,
  PLUGIN_WEB_DEV_CACHE_CONTROL,
  PLUGIN_WEB_SHIM_CACHE_CONTROL,
} from "@t3tools/shared/pluginHostWeb";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
import { pluginVersionDir } from "./PluginPaths.ts";

const PLUGIN_WEB_ROUTE_PREFIX = "/plugins/";
const PLUGIN_HOST_ROUTE_PREFIX = "/plugin-host/";
const PLUGIN_ID_PATTERN = new RegExp(`^${PLUGIN_ID_PATTERN_SOURCE}$`, "u");

// In plugin dev mode, bundles/shims are rebuilt in place at the same version, so
// serve them uncacheable; otherwise use the long-lived immutable/short caches.
const pluginDevMode = process.env.T3_PLUGIN_DEV === "1";
const pluginBundleCacheControl = pluginDevMode
  ? PLUGIN_WEB_DEV_CACHE_CONTROL
  : PLUGIN_WEB_BUNDLE_CACHE_CONTROL;
const pluginShimCacheControl = pluginDevMode
  ? PLUGIN_WEB_DEV_CACHE_CONTROL
  : PLUGIN_WEB_SHIM_CACHE_CONTROL;

const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function hasInvalidPathSegment(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  );
}

function parsePluginWebPath(pathname: string): {
  readonly pluginId: PluginId;
  readonly version: string;
  readonly relativePath: string;
} | null {
  if (!pathname.startsWith(PLUGIN_WEB_ROUTE_PREFIX)) return null;
  const rawParts = pathname.slice(PLUGIN_WEB_ROUTE_PREFIX.length).split("/");
  if (rawParts.length < 3) return null;

  const pluginId = decodeSegment(rawParts[0] ?? "");
  const version = decodeSegment(rawParts[1] ?? "");
  if (
    pluginId === null ||
    version === null ||
    !PLUGIN_ID_PATTERN.test(pluginId) ||
    hasInvalidPathSegment(version)
  ) {
    return null;
  }

  const fileParts = rawParts.slice(2).map(decodeSegment);
  if (fileParts.some((part) => part === null || hasInvalidPathSegment(part))) {
    return null;
  }
  const safeParts = fileParts as Array<string>;
  if (safeParts[0] !== "web" && safeParts[0] !== "assets") {
    return null;
  }

  return {
    pluginId: pluginId as PluginId,
    version,
    relativePath: safeParts.join("/"),
  };
}

// The lockfile gates EVERY asset request, and one plugin page load fetches
// many assets back-to-back. Cache the parsed lockfile briefly instead of
// re-reading + re-decoding it per request. The cache is keyed by the store
// instance (WeakMap) so independent layers — e.g. test fixtures — stay
// isolated. Staleness only delays visibility of a brand-new install/upgrade
// by up to the TTL; the web host's registry sync retries failed imports, so
// a transient 404 self-heals. Read failures are not cached.
const LOCKFILE_CACHE_TTL_MS = 1_000;

interface CachedLockfile {
  readonly at: number;
  readonly lockfile: PluginLockfile;
}

const lockfileCacheByStore = new WeakMap<object, CachedLockfile>();

export const readLockfileCached = <E>(
  cacheKey: object,
  readLockfile: Effect.Effect<PluginLockfile, E>,
): Effect.Effect<PluginLockfile, E> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = lockfileCacheByStore.get(cacheKey);
    if (cached && now - cached.at < LOCKFILE_CACHE_TTL_MS) {
      return cached.lockfile;
    }
    const lockfile = yield* readLockfile;
    lockfileCacheByStore.set(cacheKey, { at: now, lockfile });
    return lockfile;
  });

function isWithinRoot(root: string, candidate: string, separator: string): boolean {
  return (
    candidate === root ||
    candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)
  );
}

function contentTypeFor(filePath: string, extname: (path: string) => string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".ico":
      return "image/x-icon";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

const pluginBundleRouteLayer = HttpRouter.add(
  "GET",
  `${PLUGIN_WEB_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return notFound();
    }

    const parsed = parsePluginWebPath(url.value.pathname);
    if (!parsed) {
      return notFound();
    }

    const lockfileStore = yield* PluginLockfileStore;
    const lockfile = yield* readLockfileCached(lockfileStore, lockfileStore.readLockfile).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read plugin lockfile for web bundle route", { cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
    // Plugin web bundles are served WITHOUT auth, like the host's own static
    // assets: they are public-by-URL (id + version), contain no secrets, and
    // the lockfile pin below gates them to installed versions. That
    // intentionally includes DISABLED plugins' assets — disablement gates
    // execution (the web host never imports a disabled plugin's bundle), not
    // asset availability.
    const lockfileEntry = lockfile?.plugins[parsed.pluginId];
    if (!lockfileEntry || lockfileEntry.version !== parsed.version) {
      return notFound();
    }

    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const versionDir = pluginVersionDir(
      config.pluginsDir,
      parsed.pluginId,
      parsed.version,
      path.join,
    );
    const versionDirRealPath = yield* fileSystem
      .realPath(versionDir)
      .pipe(Effect.orElseSucceed(() => null));
    if (!versionDirRealPath) {
      return notFound();
    }

    const candidatePath = path.resolve(versionDir, parsed.relativePath);
    const candidateRealPath = yield* fileSystem
      .realPath(candidatePath)
      .pipe(Effect.orElseSucceed(() => null));
    if (!candidateRealPath || !isWithinRoot(versionDirRealPath, candidateRealPath, path.sep)) {
      return notFound();
    }

    const stat = yield* fileSystem.stat(candidateRealPath).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") {
      return notFound();
    }

    const data = yield* fileSystem
      .readFile(candidateRealPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType: contentTypeFor(candidateRealPath, path.extname),
      headers: {
        "Cache-Control": pluginBundleCacheControl,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }),
);

const pluginHostShimRouteLayer = HttpRouter.add(
  "GET",
  `${PLUGIN_HOST_ROUTE_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return notFound();
    }
    const rawPath = url.value.pathname.slice(PLUGIN_HOST_ROUTE_PREFIX.length);
    const decodedPath = decodeSegment(rawPath);
    if (!decodedPath || decodedPath.includes("\0") || decodedPath.includes("..")) {
      return notFound();
    }
    const moduleName = pluginHostModuleFromPath(decodedPath);
    if (!moduleName) {
      return notFound();
    }

    return HttpServerResponse.text(getPluginHostShimSource(moduleName), {
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      headers: {
        "Cache-Control": pluginShimCacheControl,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }),
);

export const pluginWebRouteLayer = Layer.mergeAll(pluginBundleRouteLayer, pluginHostShimRouteLayer);
