import { EnvironmentId } from "@t3tools/contracts";
import { mediaMimeType } from "@t3tools/shared/filePreview";
import {
  getProjectFaviconCacheKey,
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PROJECT_FAVICON_THUMBNAIL_SIZE = 96;
export const PROJECT_FAVICON_MAX_DATA_URL_LENGTH = 32 * 1024;
/** Larger sources are not worth decoding for an icon and are left to the remote URL. */
export const PROJECT_FAVICON_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const PROJECT_FAVICON_CACHE_MAX_BYTES = 1024 * 1024;
export const PROJECT_FAVICON_CACHE_MAX_ENTRIES = 128;

export interface ProjectFaviconTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath?: string | null | undefined;
}

const ImageDataUrl = Schema.String.check(
  Schema.isMaxLength(PROJECT_FAVICON_MAX_DATA_URL_LENGTH),
  Schema.isPattern(
    /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+={0,2}$/,
  ),
);
const Entry = Schema.Struct({
  environmentId: EnvironmentId,
  cwd: Schema.String,
  faviconPath: Schema.NullOr(Schema.String),
  revision: Schema.String,
  dataUrl: ImageDataUrl,
});
export type ProjectFaviconEntry = typeof Entry.Type;
const decodeEntry = Schema.decodeUnknownOption(Entry);
const isImageDataUrl = Schema.is(ImageDataUrl);

function keyFor(target: ProjectFaviconTarget) {
  return getProjectFaviconResourceKey(target.environmentId, target.cwd, target.faviconPath);
}

export interface ProjectFaviconStorage {
  /** Every persisted record; entries that fail validation are ignored. */
  readonly list: () => Promise<ReadonlyArray<unknown>>;
  readonly put: (key: string, entry: ProjectFaviconEntry) => Promise<void>;
  readonly remove: (key: string, entry: ProjectFaviconEntry) => Promise<void>;
}

async function readBounded(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) throw new Error("Project icon is too large to decode.");
  if (!response.body) {
    const bytes = new Uint8Array<ArrayBuffer>(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Project icon is too large to decode.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Project icon is too large to decode.");
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array<ArrayBuffer>(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetches an icon and inlines its bytes when they fit the cache limit, so SVGs
 * and small bitmaps are stored exactly as served. Larger bitmaps go through the
 * platform downscaler; larger SVGs stay remote because rasterizing them without
 * intrinsic dimensions is unreliable.
 */
export function createProjectFaviconImageLoader(input: {
  readonly fetch?: typeof fetch;
  readonly downscale: (
    image: {
      readonly url: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array<ArrayBuffer>;
    },
    signal: AbortSignal,
  ) => Promise<string>;
}) {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  return async (url: string, signal: AbortSignal): Promise<string> => {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`Project icon request failed with ${response.status}.`);
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const mimeType = contentType?.startsWith("image/") ? contentType : mediaMimeType(url);
    if (!mimeType) throw new Error("Project icon has no image type.");
    const bytes = await readBounded(response, PROJECT_FAVICON_MAX_SOURCE_BYTES);
    signal.throwIfAborted();
    const dataUrl = `data:${mimeType};base64,${Encoding.encodeBase64(bytes)}`;
    if (isImageDataUrl(dataUrl)) return dataUrl;
    if (mimeType === "image/svg+xml") throw new Error("Project icon exceeds the cache limit.");
    return input.downscale({ url, mimeType, bytes }, signal);
  };
}

/** Stores small, self-contained images so startup never needs an old signed URL. */
export function createProjectFaviconCache(input: {
  readonly storage: ProjectFaviconStorage;
  readonly load: (url: string, signal: AbortSignal) => Promise<string>;
}) {
  const entries = new Map<string, ProjectFaviconEntry>();
  const environmentRevisions = new Map<EnvironmentId, number>();
  let generation = 0;
  let hydration: Promise<void> | undefined;
  let clearing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();

  const persist = (operation: () => Promise<void>) => {
    const task: Promise<void> = operation()
      .catch(() => {
        // Keep the in-memory image if local storage is full or unavailable.
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    persist(() => input.storage.remove(key, entry));
  };

  const trim = () => {
    let bytes = 0;
    for (const entry of entries.values()) bytes += entry.dataUrl.length;
    while (
      entries.size > PROJECT_FAVICON_CACHE_MAX_ENTRIES ||
      bytes > PROJECT_FAVICON_CACHE_MAX_BYTES
    ) {
      const oldest = entries.entries().next().value;
      if (!oldest) break;
      bytes -= oldest[1].dataUrl.length;
      remove(oldest[0]);
    }
  };

  const hydrate = () =>
    (hydration ??= (async () => {
      try {
        for (const record of await input.storage.list()) {
          const entry = decodeEntry(record);
          if (Option.isSome(entry)) entries.set(keyFor(entry.value), entry.value);
        }
        trim();
      } catch {
        // A missing, corrupt, or unavailable cache must not prevent startup.
      }
    })());

  const peek = (target: ProjectFaviconTarget) => entries.get(keyFor(target))?.dataUrl ?? null;

  const resolve = async (
    target: ProjectFaviconTarget,
    url: string | null,
    signal: AbortSignal,
  ): Promise<string | null> => {
    await clearing;
    const startGeneration = generation;
    const startRevision = environmentRevisions.get(target.environmentId) ?? 0;
    await hydrate();
    if (signal.aborted || url === null) return peek(target);
    const key = keyFor(target);
    if (isProjectFaviconFallbackUrl(url)) {
      remove(key);
      return null;
    }
    const revision = getProjectFaviconCacheKey(target.environmentId, target.cwd, url);
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      if (cached.revision === revision) return cached.dataUrl;
    }
    try {
      const dataUrl = await input.load(url, signal);
      if (
        signal.aborted ||
        startGeneration !== generation ||
        startRevision !== (environmentRevisions.get(target.environmentId) ?? 0)
      ) {
        return peek(target);
      }
      if (isImageDataUrl(dataUrl)) {
        const entry = {
          environmentId: target.environmentId,
          cwd: target.cwd,
          faviconPath: target.faviconPath || null,
          revision,
          dataUrl,
        };
        entries.set(key, entry);
        persist(() => input.storage.put(key, entry));
        trim();
        return dataUrl;
      }
    } catch {
      // An outage or failed decode leaves the last successful image visible.
    }
    return peek(target) ?? url;
  };

  const flush = async () => {
    await Promise.all(pending);
  };

  // A download that started before the clear sees the revision change and is discarded;
  // one that starts during the clear waits for it, so it cannot repopulate storage.
  const clear = async (environmentId?: EnvironmentId) => {
    if (environmentId === undefined) generation += 1;
    else
      environmentRevisions.set(environmentId, (environmentRevisions.get(environmentId) ?? 0) + 1);
    const previous = clearing;
    const task = (async () => {
      await previous;
      await hydrate();
      for (const [key, entry] of entries) {
        if (environmentId === undefined || entry.environmentId === environmentId) remove(key);
      }
      await flush();
    })().finally(() => {
      if (clearing === task) clearing = undefined;
    });
    clearing = task;
    await task;
  };

  return {
    hydrate,
    peek,
    resolve,
    clearEnvironment: (environmentId: EnvironmentId) => clear(environmentId),
    clearAll: () => clear(),
    flush,
  };
}

export type ProjectFaviconCache = ReturnType<typeof createProjectFaviconCache>;
