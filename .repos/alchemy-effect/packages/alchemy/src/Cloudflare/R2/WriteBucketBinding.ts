import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { getRawStream } from "../../Util/Stream.ts";
import { makeBucketBinding, makeHelpers } from "./BucketBinding.ts";
import type {
  Conditional,
  MultipartOptions,
  MultipartUpload,
  PutOptions,
  UploadPartOptions,
  UploadedPart,
} from "./BucketTypes.ts";
import { WriteBucket, type WriteBucketClient } from "./WriteBucket.ts";

/**
 * Implementation of the {@link WriteBucket} binding that uses a Worker binding.
 */
export const WriteBucketBinding = Layer.effect(
  WriteBucket,
  Effect.suspend(() => makeBucketBinding({ makeClient: makeWrite })),
);

/** Build the write half of the binding client. */
export const makeWrite = ({
  raw,
  use,
  tryPromise,
  wrapR2Object,
  wrapR2ObjectOrBody,
}: ReturnType<typeof makeHelpers>): WriteBucketClient => {
  const wrapR2MultipartUpload = (
    upload: runtime.R2MultipartUpload,
  ): MultipartUpload => ({
    ...upload,
    raw: upload,
    uploadId: upload.uploadId,
    abort: () => tryPromise(() => upload.abort()),
    complete: (uploadedParts: UploadedPart[]) =>
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
      options?: UploadPartOptions,
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

  return {
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
      options?: PutOptions & {
        onlyIf: Conditional | Headers;
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
    createMultipartUpload: (key: string, options?: MultipartOptions) =>
      use((raw) => raw.createMultipartUpload(key, options)).pipe(
        Effect.map(wrapR2MultipartUpload),
      ),
    resumeMultipartUpload: (key: string, uploadId: string) =>
      raw.pipe(
        Effect.map((raw) => raw.resumeMultipartUpload(key, uploadId)),
        Effect.map(wrapR2MultipartUpload),
      ),
  };
};
