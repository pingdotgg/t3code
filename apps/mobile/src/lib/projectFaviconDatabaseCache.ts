import {
  createProjectFaviconCache as createSharedProjectFaviconCache,
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
  type ProjectFaviconEntry,
} from "@t3tools/client-runtime/project-favicon-cache";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import { Platform } from "react-native";

import * as MobileDatabase from "../persistence/mobile-database";

const CACHE_KIND = "project-favicon";
const CACHE_SCHEMA_VERSION = 1;

const stagedSources = new Map<string, { written: Promise<void>; users: number }>();

let database: MobileDatabase.MobileDatabase["Service"] | undefined;

export function attachProjectFaviconDatabase(service: MobileDatabase.MobileDatabase["Service"]) {
  database = service;
}

const runDatabase = <A, E>(
  use: (database: MobileDatabase.MobileDatabase["Service"]) => Effect.Effect<A, E>,
) =>
  database
    ? Effect.runPromise(use(database))
    : Promise.reject(new Error("Project icon storage is not attached."));

/** expo-image encodes only through disk cache; remove the temporary frame after reading bytes. */
export async function downscaleProjectFavicon(
  image: { readonly bytes: Uint8Array<ArrayBuffer> },
  signal: AbortSignal,
) {
  const [{ Image }, { File, Paths }, Crypto] = await Promise.all([
    import("expo-image"),
    import("expo-file-system"),
    import("expo-crypto"),
  ]);
  signal.throwIfAborted();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, image.bytes);
  const contentHash = Hex.encode(new Uint8Array(digest));
  signal.throwIfAborted();
  const requestId = Crypto.randomUUID();
  // Glide keys local images by URI, while SDWebImage honors the explicit cache key.
  const android = Platform.OS === "android";
  const source = new File(Paths.cache, `t3-favicon-source-${android ? contentHash : requestId}`);
  const sourceImage = { uri: source.uri, cacheKey: `t3-favicon-source:${contentHash}` };
  let staged = stagedSources.get(source.uri);
  if (!staged) {
    source.create({ overwrite: android });
    staged = { written: Promise.resolve().then(() => source.write(image.bytes)), users: 0 };
    stagedSources.set(source.uri, staged);
  }
  staged.users += 1;
  try {
    await staged.written;
    for (const size of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
      signal.throwIfAborted();
      const decoded = await Image.loadAsync(sourceImage, { maxWidth: size, maxHeight: size });
      try {
        signal.throwIfAborted();
        if (decoded.width > size || decoded.height > size) {
          throw new Error("Project icon was not resized.");
        }
        const cacheKey = `t3-favicon-thumbnail:${size}:${requestId}`;
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
  } finally {
    staged.users -= 1;
    if (staged.users === 0) {
      stagedSources.delete(source.uri);
      source.delete();
    }
  }
  throw new Error("Project icon thumbnail exceeds the cache limit.");
}

export const projectFaviconDatabaseCache = createSharedProjectFaviconCache({
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
