import { loadInternalWorker } from "../../internal/internal-worker.ts";
import {
  parseHeaders,
  parseRedirects,
} from "../../../internal/workers-shared/index.ts";
import {
  constructHeaders,
  constructRedirects,
} from "../../../internal/workers-shared/node/configuration/constructConfiguration.ts";
import {
  createAssetsIgnoreFunction,
  getContentType,
  normalizeFilePath,
} from "../../../internal/workers-shared/node/helpers.ts";
import { parseStaticRouting } from "../../../internal/workers-shared/shared/configuration/parseStaticRouting.ts";
import {
  CONTENT_HASH_OFFSET,
  ENTRY_SIZE,
  HEADER_SIZE,
  MAX_ASSET_COUNT,
  MAX_ASSET_SIZE,
  PATH_HASH_OFFSET,
  PATH_HASH_SIZE,
} from "../../../internal/workers-shared/shared/constants.ts";
import type {
  AssetConfig,
  RouterConfig,
  StaticRouting,
} from "../../../internal/workers-shared/shared/types.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
const AssetsKvWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/assets/assets-kv.worker",
    ),
};
const AssetsWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/assets/assets.worker",
    ),
};
const RouterWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/assets/router.worker",
    ),
};
import * as Plugin from "../../Plugin.ts";
import { PluginContext, type BindingHook } from "../../PluginContext.ts";
import { ConfigError, SystemError } from "../../RuntimeError.shared.ts";
import type { RuntimeWorker } from "../../RuntimeWorker.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";

export class Assets extends Plugin.Service<Assets, { isConfigured: boolean }>()(
  "cloudflare-runtime/plugin/Assets",
) {}

export const AssetsLive = Layer.effect(
  Assets,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    interface ManifestEntry {
      readonly pathHash: Uint8Array;
      readonly contentHash: Uint8Array;
    }
    interface AssetReverseMap {
      [contentHashHex: string]: {
        filePath: string;
        contentType: string | null;
      };
    }

    const buildAssetManifest = Effect.fn("buildAssetManifest")(function* (
      dir: string,
    ) {
      const files = yield* fs.readDirectory(dir, { recursive: true }).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () =>
            Effect.succeed([]).pipe(
              Effect.tap(() =>
                Effect.logWarning(`Could not read assets directory "${dir}"`),
              ),
            ),
        ),
        Effect.mapError(
          (cause) =>
            new SystemError({
              subtag: "Assets",
              message: `Failed to read assets directory "${dir}": ${cause.message}`,
              hint: "Ensure the assets directory exists and is readable.",
              detail: { directory: dir },
              cause,
            }),
        ),
      );
      const { assetsIgnoreFunction } = yield* createAssetsIgnoreFunction(
        dir,
      ).pipe(
        Effect.provide([
          Layer.succeed(FileSystem.FileSystem, fs),
          Layer.succeed(Path.Path, path),
        ]),
        Effect.mapError(
          (cause) =>
            new SystemError({
              subtag: "Assets",
              message: `Failed to read assets ignore file in "${dir}": ${cause.message}`,
              detail: { directory: dir },
              cause,
            }),
        ),
      );
      const manifest: Array<ManifestEntry> = [];
      const assetsReverseMap: AssetReverseMap = {};

      yield* Effect.forEach(
        files,
        (file) =>
          Effect.gen(function* () {
            if (assetsIgnoreFunction(file)) {
              return;
            }
            const filepath = path.join(dir, file);
            const relativeFilepath = path.relative(dir, filepath);
            const info = yield* fs.stat(filepath).pipe(
              Effect.mapError(
                (cause) =>
                  new SystemError({
                    subtag: "Assets",
                    message: `Failed to stat asset file "${filepath}": ${cause.message}`,
                    detail: { filepath },
                    cause,
                  }),
              ),
            );

            // TODO: decide whether to follow symbolic links
            if (info.type !== "File") {
              return;
            }

            // TODO: Warn about _worker.js

            if (info.size > BigInt(MAX_ASSET_SIZE)) {
              return yield* new ConfigError({
                subtag: "Assets",
                message:
                  `Asset too large. ` +
                  `Cloudflare Workers supports assets with sizes of up to ${MAX_ASSET_SIZE} bytes, ` +
                  `but "${filepath}" is ${info.size.toString()} bytes.`,
                hint: `Ensure all assets in your assets directory "${dir}" conform with the Workers maximum size requirement.`,
                detail: {
                  filepath,
                  size: info.size.toString(),
                  maxSize: MAX_ASSET_SIZE,
                },
              });
            }

            // The content hash for dev is hash(absolute path + mtime), so that
            // any change to the file invalidates the cached asset and avoids
            // spurious 304s. See the Miniflare reference implementation for
            // the rationale.
            const mtime = Option.getOrElse(info.mtime, () => new Date(0));
            const [pathHash, contentHash] = yield* Effect.all(
              [
                hashPath(normalizeFilePath(relativeFilepath)),
                hashPath(filepath + mtime.getTime().toString()),
              ],
              { concurrency: 2 },
            );
            manifest.push({ pathHash, contentHash });
            assetsReverseMap[bytesToHex(contentHash)] = {
              filePath: relativeFilepath,
              contentType: getContentType(filepath),
            };
          }),
        { concurrency: "unbounded", discard: true },
      );

      if (manifest.length > MAX_ASSET_COUNT) {
        return yield* new ConfigError({
          subtag: "Assets",
          message:
            `Maximum number of assets exceeded. ` +
            `Cloudflare Workers supports up to ${MAX_ASSET_COUNT.toLocaleString()} assets in a version, ` +
            `but ${manifest.length.toLocaleString()} files were found in the assets directory "${dir}".`,
          hint:
            `Ensure your assets directory contains a maximum of ${MAX_ASSET_COUNT.toLocaleString()} files, ` +
            `and that you have specified your assets directory correctly.`,
          detail: {
            directory: dir,
            count: manifest.length,
            maxCount: MAX_ASSET_COUNT,
          },
        });
      }

      manifest.sort(compareManifestEntries);
      const encodedAssetManifest = encodeManifest(manifest);
      return { encodedAssetManifest, assetsReverseMap };
    });

    const hashPath = (input: string) =>
      Effect.promise(async () => {
        const data = new TextEncoder().encode(input);
        const hashBuffer = await crypto.subtle.digest(
          "SHA-256",
          data.buffer as ArrayBuffer,
        );
        return new Uint8Array(hashBuffer, 0, PATH_HASH_SIZE);
      });

    const bytesToHex = (buffer: Uint8Array) =>
      Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");

    const compareManifestEntries = (
      a: { pathHash: Uint8Array },
      b: { pathHash: Uint8Array },
    ) => {
      if (a.pathHash.length < b.pathHash.length) {
        return -1;
      }
      if (a.pathHash.length > b.pathHash.length) {
        return 1;
      }
      for (const [i, v] of a.pathHash.entries()) {
        if (v < b.pathHash[i]!) {
          return -1;
        }
        if (v > b.pathHash[i]!) {
          return 1;
        }
      }
      return 1;
    };

    const encodeManifest = (
      manifest: ReadonlyArray<{
        pathHash: Uint8Array;
        contentHash: Uint8Array;
      }>,
    ) => {
      const bytes = new Uint8Array(HEADER_SIZE + manifest.length * ENTRY_SIZE);
      for (const [i, entry] of manifest.entries()) {
        const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
        bytes.set(entry.pathHash, entryOffset + PATH_HASH_OFFSET);
        bytes.set(entry.contentHash, entryOffset + CONTENT_HASH_OFFSET);
      }
      return bytes;
    };

    return Assets.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext;
        if (!worker.assets || !worker.assets.directory) {
          return {
            api: {
              isConfigured: false,
            },
          };
        }
        const { encodedAssetManifest, assetsReverseMap } =
          yield* buildAssetManifest(path.resolve(worker.assets.directory));
        const { assetsConfig, routerConfig } = buildAssetConfigs(worker);
        const [assetsKvWorker, assetsWorker, routerWorker] =
          yield* Effect.forEach(
            [AssetsKvWorker, AssetsWorker, RouterWorker],
            (worker) =>
              Effect.map(
                Effect.promise(worker.worker),
                formatInternalWorkerModules,
              ),
            { concurrency: "unbounded" },
          );
        return {
          services: [
            {
              name: "assets:files",
              disk: {
                path: worker.assets.directory,
              },
            },
            {
              name: "assets:kv",
              worker: {
                compatibilityDate: worker.compatibilityDate,
                compatibilityFlags: worker.compatibilityFlags,
                bindings: [
                  {
                    name: "ASSETS_FILES",
                    service: {
                      name: "assets:files",
                    },
                  },
                  {
                    name: "ASSETS_REVERSE_MAP",
                    json: JSON.stringify(assetsReverseMap),
                  },
                ],
                modules: assetsKvWorker,
              },
            },
            {
              name: "assets:worker",
              worker: {
                compatibilityDate: "2024-07-31",
                compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"],
                bindings: [
                  {
                    name: "ASSETS_KV_NAMESPACE",
                    kvNamespace: {
                      name: "assets:kv",
                    },
                  },
                  {
                    name: "ASSETS_MANIFEST",
                    data: encodedAssetManifest,
                  },
                  {
                    name: "CONFIG",
                    json: JSON.stringify(assetsConfig),
                  },
                ],
                modules: assetsWorker,
              },
            },
          ],
          middlewares: [
            {
              name: "assets:router",
              worker: {
                compatibilityDate: "2024-07-31",
                compatibilityFlags: [
                  "nodejs_compat",
                  "no_nodejs_compat_v2",
                  "enable_ctx_exports",
                ],
                bindings: [
                  {
                    name: "ASSET_WORKER",
                    service: {
                      name: "assets:worker",
                    },
                  },
                  {
                    name: "CONFIG",
                    json: JSON.stringify(routerConfig),
                  },
                ],
                modules: routerWorker,
              },
              upstreamBindingName: "USER_WORKER",
              order: -1,
            },
          ],
          api: {
            isConfigured: true,
          },
        };
      }),
    );
  }),
);

export const buildAssetConfigs = (
  worker: Pick<
    RuntimeWorker,
    "assets" | "compatibilityDate" | "compatibilityFlags"
  >,
) => {
  let headers: AssetConfig["headers"] | undefined;
  if (worker.assets?.headers) {
    const parsedHeaders = parseHeaders(worker.assets.headers);
    headers = constructHeaders({
      headers: parsedHeaders,
      headersFile: worker.assets.headers,
      logger: undefined!,
    }).headers;
  }
  let redirects: AssetConfig["redirects"] | undefined;
  if (worker.assets?.redirects) {
    const parsedRedirects = parseRedirects(worker.assets.redirects);
    redirects = constructRedirects({
      redirects: parsedRedirects,
      redirectsFile: worker.assets.redirects,
      logger: undefined!,
    }).redirects;
  }
  let staticRouting: StaticRouting | undefined;
  if (Array.isArray(worker.assets?.runWorkerFirst)) {
    staticRouting = parseStaticRouting(worker.assets.runWorkerFirst);
  }
  const routerConfig: RouterConfig = {
    // Matches wrangler: assets are served first unless `runWorkerFirst: true`.
    // An array selects routes via `static_routing` instead of the blanket flag.
    invoke_user_worker_ahead_of_assets: worker.assets?.runWorkerFirst === true,
    static_routing: staticRouting,
    has_user_worker: true,
  };
  const assetsConfig: AssetConfig = {
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: worker.compatibilityFlags,
    html_handling: worker.assets?.htmlHandling,
    not_found_handling: worker.assets?.notFoundHandling,
    headers,
    redirects,
    has_static_routing: !!staticRouting,
  };
  return { assetsConfig, routerConfig };
};

export const local = (binding: string): BindingHook<Assets> =>
  Plugin.use(Assets, (assets) =>
    assets.api.isConfigured
      ? Effect.succeed({
          name: binding,
          service: {
            name: "assets:worker",
          },
        })
      : Effect.fail(
          new ConfigError({
            subtag: "Assets",
            message:
              "An assets binding cannot be used without worker.assets being specified.",
            hint: "Remove the assets binding or specify worker.assets in your worker config.",
            detail: {
              binding,
            },
          }),
        ),
  );
