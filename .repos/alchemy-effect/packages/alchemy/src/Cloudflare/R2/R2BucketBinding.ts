import type * as runtime from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { getRawStream } from "../../Util/Stream.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { R2Bucket } from "./R2Bucket.ts";

export interface R2Object extends Omit<runtime.R2Object, "writeHttpMetadata"> {
  writeHttpMetadata(headers: Headers): Effect.Effect<void>;
}

export interface R2ObjectBody extends R2Object {
  get body(): Stream.Stream<Uint8Array, R2Error>;
  get bodyUsed(): boolean;
  arrayBuffer(): Effect.Effect<ArrayBuffer, R2Error>;
  bytes(): Effect.Effect<Uint8Array, R2Error>;
  text(): Effect.Effect<string, R2Error>;
  json<T>(): Effect.Effect<T, R2Error>;
  blob(): Effect.Effect<runtime.Blob, R2Error>;
}

export type R2GetOptions = runtime.R2GetOptions;
export type R2PutOptions = runtime.R2PutOptions & {
  contentLength?: number;
};

export type R2ListOptions = runtime.R2ListOptions;
export type R2Objects = {
  objects: R2Object[];
  delimitedPrefixes: string[];
} & (
  | {
      truncated: true;
      cursor: string;
    }
  | {
      truncated: false;
    }
);
export type R2Conditional = runtime.R2Conditional;

export class R2Error extends Data.TaggedError("R2Error")<{
  message: string;
  cause: Error;
}> {}

export interface R2MultipartUpload {
  raw: runtime.R2MultipartUpload;
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: ReadableStream | (ArrayBuffer | ArrayBufferView) | string | Blob,
    options?: R2UploadPartOptions,
  ): Effect.Effect<R2UploadedPart, R2Error>;
  abort(): Effect.Effect<void, R2Error>;
  complete(uploadedParts: R2UploadedPart[]): Effect.Effect<R2Object, R2Error>;
}
export type R2MultipartOptions = runtime.R2MultipartOptions;
export type R2UploadedPart = runtime.R2UploadedPart;
export interface R2UploadPartOptions extends runtime.R2UploadPartOptions {}

export interface R2BucketClient {
  raw: Effect.Effect<runtime.R2Bucket, never, RuntimeContext>;
  head(key: string): Effect.Effect<R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options: R2GetOptions & {
      onlyIf: runtime.R2Conditional | Headers;
    },
  ): Effect.Effect<R2ObjectBody | R2Object | null, R2Error, RuntimeContext>;
  get(
    key: string,
    options?: R2GetOptions,
  ): Effect.Effect<R2ObjectBody | null, R2Error, RuntimeContext>;
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob
      | Stream.Stream<Uint8Array, Err>,
    options?: R2PutOptions & {
      onlyIf: R2Conditional | Headers;
      contentLength?: number;
    },
  ): Effect.Effect<R2Object | null, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob,
    options?: R2PutOptions,
  ): Effect.Effect<R2Object, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob
      | Stream.Stream<Uint8Array, Err>,
    options: R2PutOptions & {
      contentLength: number;
    },
  ): Effect.Effect<R2Object, R2Error | Err, RuntimeContext>;
  delete(keys: string | string[]): Effect.Effect<void, R2Error, RuntimeContext>;
  list(
    options?: R2ListOptions,
  ): Effect.Effect<R2Objects, R2Error, RuntimeContext>;
  createMultipartUpload(
    key: string,
    options?: R2MultipartOptions,
  ): Effect.Effect<R2MultipartUpload, R2Error, RuntimeContext>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): Effect.Effect<R2MultipartUpload, R2Error, RuntimeContext>;
}

export class R2BucketBinding extends Binding.Service<
  R2BucketBinding,
  (bucket: R2Bucket) => Effect.Effect<R2BucketClient>
>()("Cloudflare.R2Bucket") {}

export const R2BucketBindingLive = Layer.effect(
  R2BucketBinding,
  Effect.gen(function* () {
    const bind = yield* R2BucketBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (bucket: R2Bucket) {
      yield* bind(bucket);
      const raw = Effect.sync(
        () => (env as Record<string, runtime.R2Bucket>)[bucket.LogicalId]!,
      );
      const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, R2Error> =>
        Effect.tryPromise({
          try: fn,
          catch: (error: any) =>
            new R2Error({
              message: error.message ?? "Unknown error",
              cause: error,
            }),
        });

      const use = <T>(
        fn: (raw: runtime.R2Bucket) => Promise<T>,
      ): Effect.Effect<T, R2Error> =>
        raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));

      const wrapR2Object = (object: runtime.R2Object): R2Object => ({
        ...object,
        writeHttpMetadata: (headers: Headers) =>
          Effect.sync(() => object.writeHttpMetadata(headers)),
      });
      const wrapR2ObjectBody = (
        object: runtime.R2ObjectBody,
      ): R2ObjectBody => ({
        ...wrapR2Object(object),
        body: Stream.fromReadableStream({
          evaluate: () =>
            object.body as any as ReadableStream<Uint8Array<ArrayBufferLike>>,
          onError: (error: any) =>
            new R2Error({
              message: error.message ?? "Unknown error",
              cause: error,
            }),
        }),
        bodyUsed: object.bodyUsed,
        arrayBuffer: () => tryPromise(() => object.arrayBuffer()),
        bytes: () => tryPromise(() => object.bytes()),
        text: () => tryPromise(() => object.text()),
        json: <T>() => tryPromise(() => object.json<T>()),
        blob: () => tryPromise(() => object.blob()),
      });

      const wrapR2Objects = (objects: runtime.R2Objects): R2Objects =>
        ({
          objects: objects.objects.map(wrapR2Object),
          delimitedPrefixes: objects.delimitedPrefixes,
          ...("cursor" in objects ? { cursor: objects.cursor } : {}),
          ...("truncated" in objects ? { truncated: objects.truncated } : {}),
        }) as R2Objects;

      const wrapR2ObjectOrBody = (
        object: runtime.R2Object | runtime.R2ObjectBody | null,
      ): R2Object | R2ObjectBody | null =>
        object === null
          ? object
          : isR2ObjectBody(object)
            ? wrapR2ObjectBody(object)
            : wrapR2Object(object);

      const wrapR2MultipartUpload = (
        upload: runtime.R2MultipartUpload,
      ): R2MultipartUpload => ({
        ...upload,
        raw: upload,
        uploadId: upload.uploadId,
        abort: () => tryPromise(() => upload.abort()),
        complete: (uploadedParts: R2UploadedPart[]) =>
          tryPromise(() => upload.complete(uploadedParts)).pipe(
            Effect.map(wrapR2Object),
          ),
        uploadPart: (
          partNumber: number,
          value:
            | ReadableStream
            | ArrayBuffer
            | ArrayBufferView
            | string
            | Blob
            | Stream.Stream<Uint8Array>,
          options?: R2UploadPartOptions,
        ) =>
          tryPromise(() =>
            upload.uploadPart(
              partNumber,
              Stream.isStream(value)
                ? value.pipe(Stream.toReadableStream())
                : (value as any),
              options,
            ),
          ),
      });

      const isR2ObjectBody = (object: any): object is runtime.R2ObjectBody =>
        object !== null && typeof object === "object" && "body" in object;

      return {
        raw: raw,
        head: (key: string) =>
          use((raw) => raw.head(key)).pipe(
            Effect.map((object) => (object ? wrapR2Object(object) : object)),
          ),
        get: (key: string, options?: R2GetOptions) =>
          use((raw) => raw.get(key, options)).pipe(
            Effect.map(wrapR2ObjectOrBody),
          ) as any,
        // @ts-expect-error
        put: (
          key: string,
          value:
            | ReadableStream
            | ArrayBuffer
            | ArrayBufferView
            | string
            | null
            | Blob
            | Stream.Stream<Uint8Array>,
          options?: R2PutOptions & {
            onlyIf: R2Conditional | Headers;
            contentLength?: number;
          },
        ) =>
          use((raw) => {
            if (Stream.isStream(value)) {
              const rawStream = getRawStream(value);
              if (rawStream) {
                return raw.put(key, rawStream as any, options);
              } else if (!options?.contentLength) {
                throw new Error("Content length is required");
              }
              // content length myst be known, so we pipe through fixed length stream
              // TODO(sam): is it more efficient to just assign the contentLength as a property?
              const readable = Stream.toReadableStream(value).pipeThrough(
                new FixedLengthStream(options.contentLength),
              );
              return raw.put(key, readable as any);
            }
            return raw.put(key, value as any, options);
          }).pipe(Effect.map(wrapR2ObjectOrBody)) as any,
        delete: (keys: string | string[]) => use((raw) => raw.delete(keys)),
        list: (options?: R2ListOptions) =>
          use((raw) => raw.list(options)).pipe(Effect.map(wrapR2Objects)),
        createMultipartUpload: (key: string, options?: R2MultipartOptions) =>
          use((raw) => raw.createMultipartUpload(key, options)).pipe(
            Effect.map(wrapR2MultipartUpload),
          ),
        resumeMultipartUpload: (key: string, uploadId: string) =>
          raw.pipe(
            Effect.map((raw) => raw.resumeMultipartUpload(key, uploadId)),
            Effect.map(wrapR2MultipartUpload),
          ),
      } satisfies R2BucketClient as R2BucketClient;
    });
  }),
);

export class R2BucketBindingPolicy extends Binding.Policy<
  R2BucketBindingPolicy,
  (bucket: R2Bucket) => Effect.Effect<void>
>()("Cloudflare.R2Bucket") {}

export const R2BucketBindingPolicyLive = R2BucketBindingPolicy.layer.succeed(
  Effect.fnUntraced(function* (host: ResourceLike, bucket: R2Bucket) {
    if (isWorker(host)) {
      yield* host.bind`${bucket}`({
        bindings: [
          {
            type: "r2_bucket",
            name: bucket.LogicalId,
            bucketName: bucket.bucketName,
            jurisdiction: bucket.jurisdiction.pipe(
              Output.map((jurisdiction) =>
                jurisdiction === "default" ? undefined : jurisdiction,
              ),
            ),
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`BucketBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);
