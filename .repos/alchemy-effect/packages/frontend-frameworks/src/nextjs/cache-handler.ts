/**
 * `@alchemy.run/frontend-frameworks/nextjs/cache-handler` — Next.js
 * `cacheHandler` backed by S3, for Next's standalone server on AWS Lambda
 * Web Functions.
 *
 * A Web Function runs Next as a long-lived server, so revalidation and image
 * optimization happen in-process the way they do under `next start`. What
 * the server can't do is keep its cache on disk: the code directory is
 * read-only, and every environment has its own `/tmp`. This handler keeps
 * Next's own semantics by extending its `FileSystemCache`, and moves the
 * shared state to S3:
 *
 * - entries (ISR pages, route handlers, the fetch cache, optimized images)
 *   are S3 objects; a miss falls back to Next's read of the prerendered
 *   build output
 * - `revalidateTag` writes one tag manifest object (conditional writes),
 *   which every environment reads into Next's in-process tags manifest
 *   before checking an entry
 *
 * The file is copied next to the standalone `server.js` and loaded by Next
 * at runtime, so it imports only Node built-ins (and Next itself, from the
 * standalone `node_modules`). Requests are signed with the function's own
 * credentials from the environment. Configuration:
 *
 * - `CACHE_BUCKET_NAME` — the bucket
 * - `CACHE_BUCKET_KEY_PREFIX` — key prefix (default `_cache`)
 */
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface TagEntry {
  stale?: number;
  expired?: number;
}

interface FileSystemCacheLike {
  get(key: string, ctx: Record<string, any>): Promise<CacheEntry | null>;
  set(key: string, data: any, ctx: Record<string, any>): Promise<void>;
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
  resetRequestCache(): void;
}

interface CacheEntry {
  lastModified: number;
  value: any;
}

const FileSystemCache: new (ctx: Record<string, any>) => FileSystemCacheLike =
  require("next/dist/server/lib/incremental-cache/file-system-cache").default;
const { tagsManifest } =
  require("next/dist/server/lib/incremental-cache/tags-manifest.external") as {
    tagsManifest: Map<string, TagEntry>;
  };

const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";
/** How long one environment trusts its copy of the tag manifest. */
const TAG_MANIFEST_TTL_MS = 1_000;

// ---------------------------------------------------------------------------
// S3 over fetch, signed with SigV4
// ---------------------------------------------------------------------------

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Uint8Array, data: string) =>
  createHmac("sha256", key).update(data).digest();

const encodeKey = (key: string) =>
  key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");

interface S3Response {
  status: number;
  etag: string | undefined;
  body: string;
}

const s3 = async (
  method: "GET" | "PUT",
  key: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<S3Response> => {
  const bucket = process.env.CACHE_BUCKET_NAME!;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const path = `/${encodeKey(key)}`;
  const body = options.body ?? "";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": sha256Hex(body),
    "x-amz-date": amzDate,
    ...(process.env.AWS_SESSION_TOKEN
      ? { "x-amz-security-token": process.env.AWS_SESSION_TOKEN }
      : {}),
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  const signedHeaders = Object.keys(headers).sort();
  const canonicalRequest = [
    method,
    path,
    "",
    ...signedHeaders.map((name) => `${name}:${headers[name]!.trim()}`),
    "",
    signedHeaders.join(";"),
    headers["x-amz-content-sha256"],
  ].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${process.env.AWS_SECRET_ACCESS_KEY}`, date), region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const { host: _host, ...sent } = headers;
  const response = await fetch(`https://${host}${path}`, {
    method,
    headers: {
      ...sent,
      authorization: `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
    },
    ...(method === "PUT" ? { body } : {}),
  });
  return {
    status: response.status,
    etag: response.headers.get("etag") ?? undefined,
    body: await response.text(),
  };
};

const prefix = () => (process.env.CACHE_BUCKET_KEY_PREFIX ?? "_cache").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Values: Buffers and Maps survive the round trip through JSON
// ---------------------------------------------------------------------------

const encode = (value: unknown) =>
  JSON.stringify(value, function (this: Record<string, unknown>, key, current) {
    const original = this[key];
    if (Buffer.isBuffer(original) || original instanceof Uint8Array) {
      return { __alchemy: "bytes", data: Buffer.from(original).toString("base64") };
    }
    if (original instanceof Map) {
      return { __alchemy: "map", data: [...original.entries()] };
    }
    return current;
  });

const decode = (text: string) =>
  JSON.parse(text, (_key, value) => {
    if (value && typeof value === "object" && "__alchemy" in value) {
      if (value.__alchemy === "bytes") return Buffer.from(value.data, "base64");
      if (value.__alchemy === "map") return new Map(value.data);
    }
    return value;
  });

// ---------------------------------------------------------------------------
// The shared tag manifest
// ---------------------------------------------------------------------------

let manifest: { tags: Record<string, TagEntry>; etag: string | undefined; fetchedAt: number } = {
  tags: {},
  etag: undefined,
  fetchedAt: 0,
};

const manifestKey = () => `${prefix()}/tags.json`;

const readManifest = async () => {
  const response = await s3("GET", manifestKey());
  if (response.status === 404) return { tags: {}, etag: undefined };
  if (response.status !== 200) {
    throw new Error(`Reading the Next.js tag manifest failed: ${response.status}`);
  }
  return { tags: JSON.parse(response.body) as Record<string, TagEntry>, etag: response.etag };
};

/** Copy the shared manifest into Next's in-process one. */
const applyManifest = (tags: Record<string, TagEntry>) => {
  for (const [tag, entry] of Object.entries(tags)) tagsManifest.set(tag, entry);
};

const refreshManifest = async () => {
  if (Date.now() - manifest.fetchedAt < TAG_MANIFEST_TTL_MS) return;
  const { tags, etag } = await readManifest();
  manifest = { tags, etag, fetchedAt: Date.now() };
  applyManifest(tags);
};

/** Read-modify-write the manifest, retrying when another writer won. */
const updateManifest = async (update: (tags: Record<string, TagEntry>) => void) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { tags, etag } = await readManifest();
    update(tags);
    const response = await s3("PUT", manifestKey(), {
      body: JSON.stringify(tags),
      headers: {
        "content-type": "application/json",
        ...(etag ? { "if-match": etag } : { "if-none-match": "*" }),
      },
    });
    if (response.status === 200) {
      manifest = { tags, etag: response.etag, fetchedAt: Date.now() };
      applyManifest(tags);
      return;
    }
    if (response.status !== 412 && response.status !== 409) {
      throw new Error(`Writing the Next.js tag manifest failed: ${response.status}`);
    }
  }
  throw new Error("Writing the Next.js tag manifest kept conflicting");
};

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

const entryKey = (key: string) => `${prefix()}/entries/${sha256Hex(key)}.json`;

/** Same expiry rules as Next's FileSystemCache, against the synced manifest. */
const isExpired = (entry: CacheEntry, ctx: Record<string, any>) => {
  const expired = (tags: string[]) =>
    tags.some((tag) => {
      const at = tagsManifest.get(tag)?.expired;
      return typeof at === "number" && at <= Date.now() && at > entry.lastModified;
    });
  const kind = entry.value?.kind;
  if (kind === "APP_PAGE" || kind === "APP_ROUTE" || kind === "PAGES") {
    const header = entry.value.headers?.[NEXT_CACHE_TAGS_HEADER];
    return typeof header === "string" && expired(header.split(","));
  }
  if (kind === "FETCH" && ctx.kind === "FETCH") {
    return expired([...(ctx.tags ?? []), ...(ctx.softTags ?? [])]);
  }
  return false;
};

export default class AlchemyS3CacheHandler extends FileSystemCache {
  constructor(ctx: Record<string, any>) {
    // Reads of the prerendered build output stay Next's. Nothing is written
    // to the read-only code directory, and there is no in-process memory
    // layer: another environment's revalidation must show up here.
    super({ ...ctx, flushToDisk: false, maxMemoryCacheSize: 0 });
  }

  override async get(key: string, ctx: Record<string, any>): Promise<CacheEntry | null> {
    await refreshManifest();
    const response = await s3("GET", entryKey(key));
    let entry: CacheEntry | null = null;
    if (response.status === 200) {
      entry = decode(response.body) as CacheEntry;
    } else if (response.status === 404) {
      // Not written since the build: Next's prerendered output, if any.
      // Next dates it by file time, which the deploy archive normalizes, so
      // date it by the build: otherwise every prerendered page looks stale
      // on its first request and renders again.
      entry = await super.get(key, ctx);
      const buildTime = Number(process.env.ALCHEMY_NEXT_BUILD_TIME);
      if (entry !== null && Number.isFinite(buildTime) && buildTime > 0) {
        entry = { ...entry, lastModified: buildTime };
      }
    } else {
      throw new Error(`Reading the Next.js cache failed: ${response.status}`);
    }
    if (entry === null || isExpired(entry, ctx)) return null;
    return entry;
  }

  override async set(key: string, data: any, ctx: Record<string, any>): Promise<void> {
    await super.set(key, data, ctx);
    if (!data) return;
    const response = await s3("PUT", entryKey(key), {
      body: encode({ lastModified: Date.now(), value: data }),
      headers: { "content-type": "application/json" },
    });
    if (response.status !== 200) {
      throw new Error(`Writing the Next.js cache failed: ${response.status}`);
    }
  }

  override async revalidateTag(
    tags: string | string[],
    durations?: { expire?: number },
  ): Promise<void> {
    const list = typeof tags === "string" ? [tags] : tags;
    if (list.length === 0) return;
    await updateManifest((manifestTags) => {
      const now = Date.now();
      for (const tag of list) {
        const existing = manifestTags[tag] ?? {};
        manifestTags[tag] = durations
          ? {
              ...existing,
              stale: now,
              ...(durations.expire !== undefined ? { expired: now + durations.expire * 1000 } : {}),
            }
          : { ...existing, expired: now };
      }
    });
  }
}
