import {
  createProjectFaviconCache,
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
  type ProjectFaviconEntry,
} from "@t3tools/client-runtime/project-favicon-cache";
import * as Effect from "effect/Effect";

import * as MobileDatabase from "../persistence/mobile-database";

const CACHE_KIND = "project-favicon";
const CACHE_SCHEMA_VERSION = 1;

let database: MobileDatabase.MobileDatabase["Service"] | undefined;

/**
 * The cache is a module singleton because the favicon atom family holds it outside
 * any Effect runtime. Its rows live in `client_cache`, so the environment cache store
 * hands over the database it already owns instead of the cache re-entering the runtime.
 */
export function attachProjectFaviconDatabase(service: MobileDatabase.MobileDatabase["Service"]) {
  database = service;
}

const runDatabase = <A, E>(
  use: (database: MobileDatabase.MobileDatabase["Service"]) => Effect.Effect<A, E>,
) =>
  database
    ? Effect.runPromise(use(database))
    : Promise.reject(new Error("Project icon storage is not attached."));

/**
 * Rasterizes a bitmap that is too large to inline. The native decoder writes the
 * downsized frame to expo-image's disk cache, which is the only encode path it
 * exposes; the temporary entry is removed once its bytes are read.
 */
export async function downscaleProjectFavicon(
  image: { readonly url: string },
  signal: AbortSignal,
) {
  const [{ Image }, { File }] = await Promise.all([
    import("expo-image"),
    import("expo-file-system"),
  ]);
  for (const size of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
    signal.throwIfAborted();
    const decoded = await Image.loadAsync(image.url, { maxWidth: size, maxHeight: size });
    const cacheKey = `t3-favicon-thumbnail:${size}:${image.url}`;
    try {
      signal.throwIfAborted();
      if (decoded.width > size || decoded.height > size) {
        throw new Error("Project icon was not resized.");
      }
      await Image.writeToCacheAsync(decoded, cacheKey);
      const path = await Image.getCachePathAsync(cacheKey);
      if (!path) throw new Error("Project icon thumbnail was not written.");
      const file = new File(path.startsWith("file:") ? path : `file://${path}`);
      try {
        if (file.size > PROJECT_FAVICON_MAX_DATA_URL_LENGTH) continue;
        const base64 = await file.base64();
        // SDWebImage chooses JPEG for opaque images and PNG for transparency; Glide always writes PNG.
        const mimeType = base64.startsWith("/9j/")
          ? "image/jpeg"
          : base64.startsWith("iVBORw0KGgo")
            ? "image/png"
            : null;
        if (!mimeType) throw new Error("Unsupported project icon thumbnail encoding.");
        const dataUrl = `data:${mimeType};base64,${base64}`;
        if (dataUrl.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return dataUrl;
      } finally {
        file.delete();
      }
    } finally {
      decoded.release();
    }
  }
  throw new Error("Project icon thumbnail exceeds the cache limit.");
}

/** Rows live in `client_cache` so Settings → Client storage counts and clears them. */
export const projectFaviconCache = createProjectFaviconCache({
  storage: {
    list: () =>
      runDatabase((database) =>
        database.listCache(CACHE_KIND).pipe(
          Effect.map((payloads) =>
            payloads.flatMap((payload): Array<unknown> => {
              try {
                return [JSON.parse(payload)];
              } catch {
                return [];
              }
            }),
          ),
        ),
      ),
    put: (key, entry: ProjectFaviconEntry) =>
      runDatabase((database) =>
        database.saveCache(
          entry.environmentId,
          CACHE_KIND,
          key,
          CACHE_SCHEMA_VERSION,
          JSON.stringify(entry),
        ),
      ),
    remove: (key, entry) =>
      runDatabase((database) => database.removeCache(entry.environmentId, CACHE_KIND, key)),
  },
  load: createProjectFaviconImageLoader({ downscale: downscaleProjectFavicon }),
});
