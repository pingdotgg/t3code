import * as s3 from "@distilled.cloud/aws/s3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { WebsiteTextEncoding } from "./shared.ts";

export interface AssetFileOption {
  /**
   * Glob or globs of files to match.
   */
  files: string | string[];
  /**
   * Override `Content-Type` for matched files.
   */
  contentType?: string;
  /**
   * Override `Cache-Control` for matched files.
   */
  cacheControl?: string;
  /**
   * Optional glob or globs excluded from this rule.
   */
  ignore?: string | string[];
}

export interface AssetDeploymentProps {
  /**
   * Destination bucket.
   */
  bucket: {
    bucketName: string;
  };
  /**
   * Local directory to upload.
   */
  sourcePath: string;
  /**
   * Optional key prefix within the bucket.
   */
  prefix?: string;
  /**
   * Remove old files under the prefix that are not part of the current deploy.
   * @default false
   */
  purge?: boolean;
  /**
   * Optional per-file overrides.
   */
  fileOptions?: AssetFileOption[];
  /**
   * Character encoding applied to inferred text-based asset content types.
   * @default "utf-8"
   */
  textEncoding?: WebsiteTextEncoding;
}

export interface AssetDeployment extends Resource<
  "AWS.Website.AssetDeployment",
  AssetDeploymentProps,
  {
    bucketName: string;
    prefix: string;
    version: string;
    fileCount: number;
  },
  never,
  Providers
> {}

/**
 * Upload a local directory into S3 with website-friendly defaults.
 *
 * `AssetDeployment` is a helper resource for website hosting. It uploads all
 * files in a directory, infers content types, applies cache-control defaults,
 * and can optionally purge stale files under a prefix.
 *
 * @section Deploying Files
 * @example Upload A Build Directory
 * ```typescript
 * const files = yield* AssetDeployment("WebsiteFiles", {
 *   bucket,
 *   sourcePath: "./dist",
 *   prefix: "_assets",
 * });
 * ```
 */
export const AssetDeployment = Resource<AssetDeployment>(
  "AWS.Website.AssetDeployment",
);

const defaultHtmlCacheControl = "max-age=0,no-cache,no-store,must-revalidate";
const defaultAssetCacheControl = "max-age=31536000,public,immutable";

export const AssetDeploymentProvider = () =>
  Provider.effect(
    AssetDeployment,
    Effect.gen(function* () {
      const reconcileSync = Effect.fn(function* (news: AssetDeploymentProps) {
        const bucketName = news.bucket.bucketName;
        const prefix = normalizePrefix(news.prefix);
        const root = news.sourcePath;
        const files = yield* Effect.tryPromise(() => walk(root));
        const hash = createHash("sha256");
        const desiredKeys = new Set<string>();

        // Observe — list every key already under the prefix and capture
        // its ETag (S3 ETag for non-multipart PUTs is the hex MD5 of the
        // body) so we can skip re-uploads when the content already matches.
        const observed = yield* listObjects(
          bucketName,
          prefix ? `${prefix}/` : prefix,
        );

        for (const relativePath of files.sort((a, b) => a.localeCompare(b))) {
          const body = yield* Effect.tryPromise(() =>
            readFile(path.join(root, relativePath)),
          );
          const normalizedRelativePath = toPosix(relativePath);
          const key = prefix
            ? `${prefix}/${normalizedRelativePath}`
            : normalizedRelativePath;
          const options = getFileOptions(
            normalizedRelativePath,
            news.fileOptions,
            news.textEncoding,
          );

          hash.update(normalizedRelativePath);
          hash.update(body);
          hash.update(options.contentType);
          hash.update(options.cacheControl);

          desiredKeys.add(key);

          // Sync — diff observed object hash against desired body hash,
          // and only PUT when the content has changed. ETag is wrapped in
          // quotes by S3 and is lower-case hex.
          const expectedETag = createHash("md5").update(body).digest("hex");
          const observedETag = observed.get(key)?.replace(/^"|"$/g, "");
          if (observedETag === expectedETag) {
            continue;
          }

          yield* s3.putObject({
            Bucket: bucketName,
            Key: key,
            Body: body,
            ContentType: options.contentType,
            CacheControl: options.cacheControl,
          });
        }

        // Sync purge — delete observed keys that aren't in the desired
        // set. Reuses the same observation rather than re-listing.
        if (news.purge ?? false) {
          const staleKeys = [...observed.keys()].filter(
            (key) => !desiredKeys.has(key),
          );
          yield* deleteKeys(bucketName, staleKeys);
        }

        return {
          bucketName,
          prefix,
          version: hash.digest("hex"),
          fileCount: files.length,
        };
      });

      return {
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const output = yield* retryForBucketReadiness(reconcileSync(news));
          yield* session.note(
            `Uploaded ${output.fileCount} file(s) to s3://${output.bucketName}/${output.prefix}`,
          );
          return output;
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          if (!(olds.purge ?? false)) {
            return;
          }
          const prefix = output.prefix ? `${output.prefix}/` : output.prefix;
          yield* retryForBucketReadiness(
            Effect.gen(function* () {
              const existingKeys = yield* listKeys(output.bucketName, prefix);
              yield* deleteKeys(output.bucketName, existingKeys);
            }),
          ).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
        }),
      };
    }),
  );

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const toPosix = (value: string) => value.split(path.sep).join("/");

const withCharset = (mimeType: string, textEncoding: WebsiteTextEncoding) =>
  textEncoding === "none" ? mimeType : `${mimeType}; charset=${textEncoding}`;

const inferContentType = (
  file: string,
  textEncoding: WebsiteTextEncoding = "utf-8",
) => {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".html":
      return withCharset("text/html", textEncoding);
    case ".css":
      return withCharset("text/css", textEncoding);
    case ".js":
    case ".mjs":
      return withCharset("application/javascript", textEncoding);
    case ".json":
      return withCharset("application/json", textEncoding);
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
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return withCharset("text/plain", textEncoding);
    case ".xml":
      return withCharset("application/xml", textEncoding);
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
};

const defaultCacheControlFor = (file: string) =>
  path.extname(file).toLowerCase() === ".html"
    ? defaultHtmlCacheControl
    : defaultAssetCacheControl;

const escapeRegex = (value: string) =>
  value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const globToRegExp = (glob: string) =>
  new RegExp(
    `^${escapeRegex(toPosix(glob))
      .replace(/\\\*\\\*/g, ".*")
      .replace(/\\\*/g, "[^/]*")
      .replace(/\\\?/g, ".")}$`,
  );

const matchesAny = (file: string, globs: string | string[]) =>
  (Array.isArray(globs) ? globs : [globs]).some((glob) =>
    globToRegExp(glob).test(file),
  );

const getFileOptions = (
  file: string,
  options: AssetFileOption[] | undefined,
  textEncoding: WebsiteTextEncoding | undefined,
): {
  contentType: string;
  cacheControl: string;
} => {
  const matched = [...(options ?? [])]
    .reverse()
    .find(
      (option) =>
        matchesAny(file, option.files) &&
        !(option.ignore && matchesAny(file, option.ignore)),
    );

  return {
    contentType:
      matched?.contentType ?? inferContentType(file, textEncoding ?? "utf-8"),
    cacheControl: matched?.cacheControl ?? defaultCacheControlFor(file),
  };
};

const walk = async (root: string, dir = ""): Promise<string[]> => {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(root, relative);
      }
      return [relative];
    }),
  );
  return files.flat();
};

const listKeys = Effect.fn(function* (bucketName: string, prefix: string) {
  let continuationToken: string | undefined;
  const keys: string[] = [];

  do {
    const response = yield* s3.listObjectsV2({
      Bucket: bucketName,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    });
    keys.push(
      ...(response.Contents ?? []).flatMap((item) =>
        item.Key ? [item.Key] : [],
      ),
    );
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
});

/** List `{key -> ETag}` pairs under `prefix`. ETag from S3 is wrapped in
 * quotes; for non-multipart uploads it is the hex MD5 of the object body. */
const listObjects = Effect.fn(function* (bucketName: string, prefix: string) {
  let continuationToken: string | undefined;
  const out = new Map<string, string>();

  do {
    const response = yield* s3.listObjectsV2({
      Bucket: bucketName,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    });
    for (const item of response.Contents ?? []) {
      if (item.Key && item.ETag) {
        out.set(item.Key, item.ETag);
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return out;
});

const deleteKeys = Effect.fn(function* (bucketName: string, keys: string[]) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    if (batch.length === 0) {
      continue;
    }
    yield* s3.deleteObjects({
      Bucket: bucketName,
      Delete: {
        Objects: batch.map((Key) => ({ Key })),
        Quiet: true,
      },
    });
  }
});

const isMissingBucket = (error: unknown) =>
  (error as { _tag?: string })._tag === "NoSuchBucket";

const retryForBucketReadiness = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: isMissingBucket,
      schedule: Schedule.exponential("100 millis").pipe(
        Schedule.both(Schedule.recurs(30)),
        Schedule.map(([duration]) =>
          Duration.isGreaterThan(duration, Duration.seconds(2))
            ? Duration.seconds(2)
            : duration,
        ),
      ),
    }),
  );
