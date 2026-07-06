import { PLUGIN_ID_PATTERN_SOURCE, type PluginId } from "@t3tools/contracts/plugin";
import {
  getPluginHostShimSource,
  pluginHostModuleFromPath,
  PLUGIN_WEB_BUNDLE_CACHE_CONTROL,
  PLUGIN_WEB_SHIM_CACHE_CONTROL,
} from "@t3tools/shared/pluginHostWeb";
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
    const lockfile = yield* lockfileStore.readLockfile.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read plugin lockfile for web bundle route", { cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
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
        "Cache-Control": PLUGIN_WEB_BUNDLE_CACHE_CONTROL,
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
        "Cache-Control": PLUGIN_WEB_SHIM_CACHE_CONTROL,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }),
);

export const pluginWebRouteLayer = Layer.mergeAll(pluginBundleRouteLayer, pluginHostShimRouteLayer);
