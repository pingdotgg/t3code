import createIgnore from "@alchemy.run/node-utils/ignore";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { sha256, sha256Object } from "../../Util/index.ts";

const MAX_ASSET_SIZE = 1024 * 1024 * 25; // 25MB
const MAX_ASSET_COUNT = 20_000;

export interface Assets {
  kind: "Cloudflare.Workers.Assets";
}

export const isAssets = (value: any): value is Assets =>
  value?.kind === "Cloudflare.Workers.Assets";

export interface AssetsConfig extends Exclude<
  Exclude<workers.PutScriptRequest["metadata"]["assets"], undefined>["config"],
  undefined
> {}

export interface AssetReadResult {
  directory: string;
  config: AssetsConfig | undefined;
  manifest: Record<string, { hash: string; size: number }>;
  _headers: string | undefined;
  _redirects: string | undefined;
  hash: string;
}

export interface AssetsProps {
  directory: string;
  config?: AssetsConfig;
}

export type ValidationError =
  | AssetTooLargeError
  | TooManyAssetsError
  | AssetNotFoundError
  | FailedToReadAssetError;

export class AssetTooLargeError extends Data.TaggedError("AssetTooLargeError")<{
  message: string;
  name: string;
  size: number;
}> {}

export class TooManyAssetsError extends Data.TaggedError("TooManyAssetsError")<{
  message: string;
  directory: string;
  count: number;
}> {}

export class AssetNotFoundError extends Data.TaggedError("AssetNotFoundError")<{
  message: string;
  hash: string;
}> {}

export class FailedToReadAssetError extends Data.TaggedError(
  "FailedToReadAssetError",
)<{
  message: string;
  name: string;
  cause: PlatformError;
}> {}

const getContentType = (name: string) => {
  if (name.endsWith(".html")) return "text/html";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".sql")) return "text/sql";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".js") || name.endsWith(".mjs")) {
    // Browsers only accept JavaScript module scripts when the MIME type is a
    // "JavaScript MIME type" (e.g. text/javascript). application/javascript+module
    // is not valid and causes strict module loading to fail.
    return "text/javascript; charset=utf-8";
  }
  if (name.endsWith(".css")) return "text/css";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
};

const maybeReadString = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
  );
});

const createIgnoreMatcher = (patterns: string[]) => {
  const matcher = createIgnore().add(patterns);
  return (file: string) => matcher.ignores(file);
};

export const readAssets = Effect.fnUntraced(function* (props: AssetsProps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedDirectory = path.resolve(props.directory);
  const [files, ignore, _headers, _redirects] = yield* Effect.all([
    fs.readDirectory(resolvedDirectory, { recursive: true }),
    maybeReadString(path.join(resolvedDirectory, ".assetsignore")),
    maybeReadString(path.join(resolvedDirectory, "_headers")),
    maybeReadString(path.join(resolvedDirectory, "_redirects")),
  ]);
  const ignores = createIgnoreMatcher([
    ".assetsignore",
    "_headers",
    "_redirects",
    ...(ignore
      ?.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")) ?? []),
  ]);
  const manifest = new Map<string, { hash: string; size: number }>();
  let count = 0;
  yield* Effect.forEach(
    files,
    Effect.fnUntraced(function* (name) {
      if (ignores(name)) {
        return;
      }
      const file = path.join(resolvedDirectory, name);
      const stat = yield* fs.stat(file);
      if (stat.type !== "File") {
        return;
      }
      const size = Number(stat.size);
      if (size > MAX_ASSET_SIZE) {
        return yield* new AssetTooLargeError({
          message: `Asset ${name} is too large (the maximum size is ${MAX_ASSET_SIZE / 1024 / 1024} MB; this asset is ${size / 1024 / 1024} MB)`,
          name,
          size,
        });
      }
      const hash = yield* fs.readFile(file).pipe(
        Effect.flatMap(sha256),
        Effect.map((hash) => hash.slice(0, 32)),
      );
      count++;
      if (count > MAX_ASSET_COUNT) {
        return yield* new TooManyAssetsError({
          message: `Too many assets (the maximum count is ${MAX_ASSET_COUNT}; this directory has ${count} assets)`,
          directory: props.directory,
          count,
        });
      }
      manifest.set(
        (name.startsWith("/") ? name : `/${name}`).replaceAll("\\", "/"),
        {
          hash,
          size,
        },
      );
    }),
  );
  const sortedManifest = Object.fromEntries(
    Array.from(manifest.entries()).sort((a, b) => a[0].localeCompare(b[0])),
  );
  // Hash only inputs that affect what gets uploaded — the file
  // manifest, asset config, and the special `_headers` / `_redirects`
  // files. `directory` is deliberately excluded: identical bytes at a
  // different absolute path must produce the same hash, otherwise
  // diffing across machines (CI runner → local laptop, monorepo
  // root → workspace root, etc.) spuriously reports "changed" and
  // causes both unnecessary re-uploads and `NotFound` failures when
  // the previously-recorded path is gone.
  const hash = yield* sha256Object({
    config: props.config,
    manifest: sortedManifest,
    _headers,
    _redirects,
  });
  return {
    directory: props.directory,
    config: props.config,
    manifest: sortedManifest,
    _headers,
    _redirects,
    hash,
  };
});

export const uploadAssets = Effect.fnUntraced(function* (
  accountId: string,
  workerName: string,
  assets: AssetReadResult,
  { note }: ScopedPlanStatusSession,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const createScriptAssetUpload = yield* workers.createScriptAssetUpload;
  const createAssetUpload = yield* workers.createAssetUpload;

  yield* note("Checking assets...");
  const session = yield* createScriptAssetUpload({
    accountId,
    scriptName: workerName,
    manifest: assets.manifest,
  });
  if (!session.buckets?.length) {
    return { jwt: session.jwt ?? undefined };
  }
  if (!session.jwt) {
    return { jwt: undefined };
  }
  const uploadJwt = session.jwt;
  let uploaded = 0;
  const total = session.buckets.flat().length;
  yield* note(`Uploaded ${uploaded} of ${total} assets...`);
  const assetsByHash = new Map<string, string>();
  for (const [name, { hash }] of Object.entries(assets.manifest)) {
    assetsByHash.set(hash, name);
  }
  let jwt: string | undefined | null;
  const directory = path.resolve(assets.directory);
  yield* Effect.forEach(
    session.buckets,
    Effect.fnUntraced(function* (bucket) {
      const body: Record<string, File> = {};
      yield* Effect.forEach(
        bucket,
        Effect.fnUntraced(function* (hash) {
          const name = assetsByHash.get(hash);
          if (!name) {
            return yield* new AssetNotFoundError({
              message: `Asset ${hash} not found in manifest`,
              hash,
            });
          }
          const file = yield* fs.readFile(path.join(directory, name)).pipe(
            Effect.mapError(
              (error) =>
                new FailedToReadAssetError({
                  message: `Failed to read asset ${name}: ${error.message}`,
                  name,
                  cause: error,
                }),
            ),
          );
          body[hash] = new File([Buffer.from(file).toString("base64")], hash, {
            type: getContentType(name),
          });
        }),
      );
      const result = yield* createAssetUpload({
        accountId,
        base64: true,
        body,
        jwtToken: uploadJwt,
      });

      uploaded += bucket.length;
      yield* note(`Uploaded ${uploaded} of ${total} assets...`);
      if (result.jwt) {
        jwt = result.jwt;
      }
    }),
  );
  return { jwt: jwt ?? undefined };
});
