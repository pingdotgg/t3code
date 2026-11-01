import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import type { PropsInput } from "../Input.ts";
import * as Provider from "../Provider.ts";
import { Resource, type ResourceClass } from "../Resource.ts";
import { createInternalTags } from "../Tags.ts";
import { bucketStorageClient, type BucketAttributes } from "./Bucket.ts";
import type { Providers } from "./Providers.ts";
import type { StoragePutOptions } from "./Storage.ts";

export type ObjectProps<T = never> = {
  /** Target bucket; its branch and credentials are inferred. */
  bucket: BucketAttributes;
  /** Object key. Moving keys or buckets replaces the object create-first. */
  key: string;
  /** Content type. JSON values default to application/json. */
  contentType?: string;
  /** HTTP cache policy. */
  cacheControl?: string;
  /** HTTP download filename/disposition. */
  contentDisposition?: string;
  /** HTTP content encoding. */
  contentEncoding?: string;
  /** Application metadata; keys are normalized to lowercase and alchemy-* names are reserved. */
  metadata?: Record<string, string>;
} & (
  | {
      /** Typed JSON desired state, serialized deterministically. */
      value: T;
      /** Optional runtime validation of externally written JSON. */
      schema?: Schema.Codec<T>;
      body?: never;
      source?: never;
    }
  | {
      /** Raw text or bytes; not JSON encoded. */
      body: string | Uint8Array;
      value?: never;
      source?: never;
      schema?: never;
    }
  | {
      /** File read through the Effect filesystem during reconciliation. */
      source: string;
      value?: never;
      body?: never;
      schema?: never;
    }
);

export interface ObjectAttributes {
  /** Target bucket and branch identity. */
  bucket: BucketAttributes;
  /** Object key. */
  key: string;
  /** Opaque S3 entity tag; never assumed to be an MD5. */
  etag: string | undefined;
  /** Observed byte length. */
  size: number;
  /** SHA-256 of observed bytes. */
  contentHash: string;
  /** Whether the declared payload is JSON. */
  json: boolean;
  /** Observed content type. */
  contentType: string | undefined;
  /** Observed cache policy. */
  cacheControl: string | undefined;
  /** Observed content disposition. */
  contentDisposition: string | undefined;
  /** Observed encoding. */
  contentEncoding: string | undefined;
  /** Observed application and ownership metadata. */
  metadata: Record<string, string>;
}

export interface Object<T = never> extends Resource<
  "Neon.Object",
  ObjectProps<T>,
  ObjectAttributes,
  never,
  Providers
> {}
const ObjectResource = Resource<Object<unknown>>("Neon.Object");
type ObjectConstructor = Pick<
  ResourceClass<Object<unknown>>,
  "Type" | "Provider" | "Props" | "Self" | "Aliases"
> & {
  <T = never>(
    id: string,
    props: PropsInput<ObjectProps<T>>,
  ): Effect.Effect<Object<T>, never, Providers>;
};

/**
 * A typed declarative object. JSON values are serialized automatically and their
 * type is retained by ReadObject and WriteObject. A generic alone is not runtime
 * validation; add a schema when external writers may violate the contract.
 * Declared content is infrastructure desired state, not mutable application data.
 *
 * ### JSON Values
 * **Example:** Inferred settings
 * ```typescript
 * const settings = yield* Neon.Object("Settings", {
 *   bucket: uploads, key: "settings.json", value: { theme: "system", pageSize: 25 },
 * });
 * ```
 *
 * ### File Content
 * **Example:** An SVG without JSON serialization
 * ```typescript
 * const logo = yield* Neon.Object("Logo", {
 *   bucket: assets, key: "logo.svg", source: "./assets/logo.svg", contentType: "image/svg+xml",
 * });
 * ```
 *
 * @resource
 * @product Bucket
 */
export const Object = ObjectResource as ObjectConstructor;

export class ObjectDecodeError extends Data.TaggedError("ObjectDecodeError")<{
  message: string;
}> {}

/** Stable JSON with explicit rejection of lossy values and cycles. */
export const serializeObjectValue = (value: unknown) =>
  Effect.try({
    try: () => {
      const ancestors = new Set<object>();
      const encode = (value: unknown): string => {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "boolean"
        )
          return JSON.stringify(value);
        if (typeof value === "number" && Number.isFinite(value))
          return JSON.stringify(value);
        if (typeof value !== "object" || value === null)
          throw new Error("Unsupported JSON value");
        if (ancestors.has(value)) throw new Error("Cyclic JSON value");
        if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
          throw new Error("Symbol JSON keys are unsupported");
        ancestors.add(value);
        let encoded: string;
        if (Array.isArray(value)) {
          if (
            globalThis.Object.getOwnPropertyNames(value).length !==
            value.length + 1
          )
            throw new Error(
              "Sparse arrays and array properties are unsupported",
            );
          encoded = `[${Array.from({ length: value.length }, (_, index) => {
            const descriptor = globalThis.Object.getOwnPropertyDescriptor(
              value,
              String(index),
            );
            if (
              !descriptor ||
              !descriptor.enumerable ||
              !("value" in descriptor)
            )
              throw new Error(
                "Sparse arrays, non-enumerable fields and accessors are unsupported",
              );
            return encode(descriptor.value);
          }).join(",")}]`;
        } else {
          if (
            globalThis.Object.getPrototypeOf(value) !==
              globalThis.Object.prototype &&
            globalThis.Object.getPrototypeOf(value) !== null
          )
            throw new Error("JSON values must be plain records");
          if (
            globalThis.Object.getOwnPropertyNames(value).length !==
            globalThis.Object.keys(value).length
          )
            throw new Error("Non-enumerable JSON fields are unsupported");
          encoded = `{${globalThis.Object.keys(value)
            .sort()
            .map((key) => {
              const descriptor = globalThis.Object.getOwnPropertyDescriptor(
                value,
                key,
              )!;
              if (!("value" in descriptor))
                throw new Error("JSON accessors are unsupported");
              return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
            })
            .join(",")}}`;
        }
        ancestors.delete(value);
        return encoded;
      };
      return encode(value);
    },
    catch: () =>
      new ObjectDecodeError({
        message: "Value is not losslessly serializable JSON",
      }),
  });

export const storageBodyBytes = (
  body: Stream.Stream<Uint8Array, Error> | undefined,
) =>
  body === undefined
    ? Effect.succeed(new Uint8Array())
    : Stream.runCollect(body).pipe(
        Effect.map((chunks) => {
          const bytes = new Uint8Array(
            chunks.reduce((size, chunk) => size + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return bytes;
        }),
      );

const hashBytes = (bytes: Uint8Array) =>
  Effect.sync(() => createHash("sha256").update(bytes).digest("hex"));
const isJson = (props: ObjectProps<unknown>) => "value" in props;
const desiredBytes = Effect.fn(function* (props: ObjectProps<unknown>) {
  if (isJson(props)) {
    const value = props.schema
      ? yield* Schema.decodeUnknownEffect(props.schema)(props.value).pipe(
          Effect.mapError(
            () =>
              new ObjectDecodeError({
                message: "Declared JSON does not satisfy its schema",
              }),
          ),
        )
      : props.value;
    const json = yield* serializeObjectValue(value);
    return yield* Effect.sync(() => new TextEncoder().encode(json));
  }
  if (props.source !== undefined)
    return yield* (yield* FileSystem.FileSystem).readFile(props.source);
  const body = props.body!;
  return typeof body === "string"
    ? yield* Effect.sync(() => new TextEncoder().encode(body))
    : body;
});

const observeObject = Effect.fn(function* (
  bucket: BucketAttributes,
  key: string,
  json: boolean,
) {
  const client = yield* bucketStorageClient(bucket);
  const object = yield* client.get(key);
  if (!object) return undefined;
  const body = yield* storageBodyBytes(object.Body);
  return {
    bucket,
    key,
    json,
    etag: object.ETag,
    size: body.length,
    contentHash: yield* hashBytes(body),
    contentType: object.ContentType,
    cacheControl: object.CacheControl,
    contentDisposition: object.ContentDisposition,
    contentEncoding: object.ContentEncoding,
    metadata: globalThis.Object.fromEntries(
      globalThis.Object.entries(object.Metadata ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  } satisfies ObjectAttributes;
});

const ownership = Effect.fn(function* (id: string, bucket: BucketAttributes) {
  const tags = yield* createInternalTags(id);
  return {
    "alchemy-stack": tags["alchemy::stack"],
    "alchemy-stage": tags["alchemy::stage"],
    "alchemy-id": id,
    "alchemy-branch": bucket.branchId,
  };
});

export const ObjectProvider = () =>
  Provider.succeed(ObjectResource, {
    stables: ["key"],
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || !output) return;
      if (
        news.key !== output.key ||
        news.bucket.bucketName !== output.bucket.bucketName ||
        news.bucket.projectId !== output.bucket.projectId ||
        news.bucket.branchId !== output.bucket.branchId
      )
        return { action: "replace" };
      if (news.source !== undefined) return { action: "update" };
    }),
    read: Effect.fn(function* ({ fqn, olds, output }) {
      const bucket = output?.bucket ?? olds?.bucket;
      if (!bucket?.bucketName) return undefined;
      const attrs = yield* observeObject(
        bucket,
        output?.key ?? olds.key,
        isJson(olds),
      );
      if (!attrs) return undefined;
      const expected = yield* ownership(fqn, attrs.bucket);
      return globalThis.Object.entries(expected).every(
        ([key, value]) => attrs.metadata[key] === value,
      )
        ? attrs
        : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ fqn, news }) {
      const bucket = news.bucket;
      const client = yield* bucketStorageClient(bucket);
      const body = yield* desiredBytes(news);
      const hash = yield* hashBytes(body);
      const current = yield* observeObject(bucket, news.key, isJson(news));
      if (
        globalThis.Object.keys(news.metadata ?? {}).some((key) =>
          key.toLowerCase().startsWith("alchemy-"),
        )
      ) {
        return yield* new ObjectDecodeError({
          message: "alchemy-* object metadata is reserved for ownership",
        });
      }
      const entries = globalThis.Object.entries(news.metadata ?? {});
      const applicationMetadata = globalThis.Object.fromEntries(
        entries.map(([key, value]) => [key.toLowerCase(), value]),
      );
      if (
        globalThis.Object.keys(applicationMetadata).length !== entries.length
      ) {
        return yield* new ObjectDecodeError({
          message: "Object metadata keys must be unique ignoring case",
        });
      }
      const metadata = {
        ...applicationMetadata,
        ...(yield* ownership(fqn, bucket)),
      };
      const options: StoragePutOptions = {
        ContentType:
          news.contentType ??
          (isJson(news) ? "application/json" : "application/octet-stream"),
        CacheControl: news.cacheControl,
        ContentDisposition: news.contentDisposition,
        ContentEncoding: news.contentEncoding,
        Metadata: metadata,
      };
      if (
        !current ||
        current.contentHash !== hash ||
        current.contentType !== options.ContentType ||
        current.cacheControl !== options.CacheControl ||
        current.contentDisposition !== options.ContentDisposition ||
        current.contentEncoding !== options.ContentEncoding ||
        (yield* serializeObjectValue(current.metadata)) !==
          (yield* serializeObjectValue(metadata))
      ) {
        yield* client.put(news.key, body, options);
      }
      const result = yield* observeObject(bucket, news.key, isJson(news));
      if (!result)
        return yield* new ObjectDecodeError({
          message: "Object was not readable after upload",
        });
      return result;
    }),
    delete: Effect.fn(function* ({ output }) {
      const client = yield* bucketStorageClient(output.bucket);
      yield* client
        .delete(output.key)
        .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
    }),
  });
