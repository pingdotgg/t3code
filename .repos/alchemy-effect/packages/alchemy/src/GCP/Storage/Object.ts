import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createHash } from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { initialCwd } from "../../Util/Node.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { makeObjectMedia } from "./ObjectMedia.ts";

export type ObjectProps = {
  /**
   * Name of the bucket that holds the object. Changing it replaces the
   * object (the new one is written before the old one is deleted).
   */
  bucketName: string;
  /**
   * Object name (key), e.g. `index.html` or `assets/app.js`. Changing it
   * replaces the object.
   */
  key: string;
  /**
   * Inline object content. Strings are encoded as UTF-8. Exactly one of
   * `content` or `file` must be set.
   */
  content?: string | Uint8Array;
  /**
   * Path of a local file to upload, resolved against the working directory
   * the deploy started in. The file is re-hashed on every plan, so edits
   * re-upload without any prop change.
   */
  file?: string;
  /**
   * `Content-Type` served with the object. Inferred from the key's
   * extension when omitted (`.html` → `text/html; charset=utf-8`, …).
   * @default inferred from `key`, else `text/plain; charset=utf-8` for string content and `application/octet-stream` otherwise
   */
  contentType?: string;
  /**
   * `Cache-Control` served with the object. When omitted, Cloud Storage
   * serves publicly readable objects with `public, max-age=3600`.
   */
  cacheControl?: string;
};

export type Object = Resource<
  "GCP.Storage.Object",
  ObjectProps,
  {
    /** Name of the bucket that holds the object. */
    bucketName: string;
    /** Object name (key). */
    key: string;
    /** Content generation of the live object. */
    generation: string | undefined;
    /** Base64 MD5 of the object bytes, as reported by Cloud Storage. */
    md5Hash: string | undefined;
    /** Size of the object in bytes. */
    size: number;
    /** `Content-Type` the object is served with. */
    contentType: string | undefined;
    /** `Cache-Control` the object is served with. */
    cacheControl: string | undefined;
    /** Authenticated media download link. */
    mediaLink: string | undefined;
    /**
     * Path-style public URL (`https://storage.googleapis.com/{bucket}/{key}`).
     * Only readable anonymously when the bucket grants `allUsers` read.
     */
    url: string;
  },
  never,
  Providers
>;

/**
 * A single object in a Cloud Storage bucket whose content is declared as
 * infrastructure — inline `content` or a local `file`.
 *
 * Reconcile observes the live object and uploads only when its MD5,
 * `Content-Type`, `Cache-Control`, or ownership metadata differ from the
 * desired state. Use {@link Files} to upload a whole directory.
 *
 * ### Uploading content
 * **Example:** Inline content
 * ```typescript
 * const bucket = yield* GCP.Storage.Bucket("assets", { forceDestroy: true });
 * yield* GCP.Storage.Object("Robots", {
 *   bucketName: bucket.bucketName,
 *   key: "robots.txt",
 *   content: "User-agent: *\nAllow: /\n",
 * });
 * ```
 *
 * **Example:** A local file with caching
 * ```typescript
 * yield* GCP.Storage.Object("Logo", {
 *   bucketName: bucket.bucketName,
 *   key: "logo.svg",
 *   file: "./public/logo.svg",
 *   cacheControl: "public, max-age=31536000, immutable",
 * });
 * ```
 *
 * @resource
 * @category Storage
 */
export const Object = Resource<Object>("GCP.Storage.Object");

export class ObjectContentInvalid extends Data.TaggedError(
  "GCP.Storage.ObjectContentInvalid",
)<{
  key: string;
  message: string;
}> {}

const TEXT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

const BINARY_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

/**
 * `Content-Type` for an object name, by extension. Text types carry
 * `charset=utf-8`. Returns `undefined` for unknown extensions.
 */
export const inferContentType = (key: string): string | undefined => {
  const base = key.split("/").pop() ?? key;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot).toLowerCase();
  const text = TEXT_TYPES[ext];
  if (text !== undefined) return `${text}; charset=utf-8`;
  return BINARY_TYPES[ext];
};

const desiredContentType = (props: ObjectProps) =>
  props.contentType ??
  inferContentType(props.key) ??
  (typeof props.content === "string"
    ? "text/plain; charset=utf-8"
    : "application/octet-stream");

const desiredBytes = Effect.fn(function* (props: ObjectProps) {
  if ((props.content === undefined) === (props.file === undefined)) {
    return yield* new ObjectContentInvalid({
      key: props.key,
      message: "exactly one of `content` or `file` must be set",
    });
  }
  if (props.file !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFile(path.resolve(initialCwd, props.file));
  }
  const content = props.content!;
  return typeof content === "string"
    ? yield* Effect.sync(() => new TextEncoder().encode(content))
    : content;
});

const md5Of = (bytes: Uint8Array) =>
  Effect.sync(() => createHash("md5").update(bytes).digest("base64"));

const publicUrl = (bucketName: string, key: string) =>
  `https://storage.googleapis.com/${bucketName}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

const toAttrs = (
  bucketName: string,
  key: string,
  object: storage.Storage_Object,
) => ({
  bucketName,
  key,
  generation: object.generation,
  md5Hash: object.md5Hash,
  size: Number(object.size ?? 0),
  contentType: object.contentType,
  cacheControl: object.cacheControl,
  mediaLink: object.mediaLink,
  url: publicUrl(bucketName, key),
});

const observe = (bucketName: string, key: string) =>
  storage
    .getObjects({ bucket: bucketName, object: key })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const sameMetadata = (
  observed: Record<string, string>,
  desired: Record<string, string>,
) =>
  globalThis.Object.entries(desired).every(
    ([key, value]) => observed[key] === value,
  );

export const ObjectProvider = () =>
  Provider.effect(
    Object,
    Effect.gen(function* () {
      const media = yield* makeObjectMedia;

      return {
        stables: ["bucketName", "key", "url"],

        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          if (
            news.bucketName !== output.bucketName ||
            news.key !== output.key
          ) {
            return { action: "replace" as const, deleteFirst: false };
          }
          // The observed MD5 + served headers fully describe the object, so
          // a `file` edit is caught by hashing it and a re-serialized
          // `content` with identical bytes stays a no-op.
          const bytes = yield* desiredBytes(news);
          const md5 = yield* md5Of(bytes);
          const unchanged =
            md5 === output.md5Hash &&
            desiredContentType(news) === output.contentType &&
            news.cacheControl === output.cacheControl;
          return unchanged
            ? { action: "noop" as const }
            : { action: "update" as const, stables: ["bucketName", "key"] };
        }),

        read: Effect.fn(function* ({ fqn, olds, output }) {
          const bucketName = output?.bucketName ?? olds?.bucketName;
          const key = output?.key ?? olds?.key;
          if (bucketName === undefined || key === undefined) return undefined;
          const object = yield* observe(bucketName, key);
          if (object === undefined) return undefined;
          const attrs = toAttrs(bucketName, key, object);
          return (yield* hasAlchemyLabels(fqn, tagRecord(object.metadata)))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ fqn, news }) {
          const bytes = yield* desiredBytes(news);
          const md5 = yield* md5Of(bytes);
          const contentType = desiredContentType(news);
          const ownership = yield* createInternalLabels(fqn);

          // Observe — the live object is the baseline, not olds/output.
          const current = yield* observe(news.bucketName, news.key);
          const inSync =
            current !== undefined &&
            current.md5Hash === md5 &&
            current.contentType === contentType &&
            current.cacheControl === news.cacheControl &&
            sameMetadata(tagRecord(current.metadata), ownership);
          if (current !== undefined && inSync) {
            return toAttrs(news.bucketName, news.key, current);
          }

          // Ensure — a multipart upload replaces content and metadata in
          // one write, so a stale object converges in a single call.
          const uploaded = yield* media.upload(news.bucketName, {
            name: news.key,
            body: bytes,
            contentType,
            cacheControl: news.cacheControl,
            metadata: ownership,
          });
          return toAttrs(news.bucketName, news.key, uploaded);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* storage
            .deleteObjects({ bucket: output.bucketName, object: output.key })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
